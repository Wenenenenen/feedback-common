/* app.js — 界面与调度 */
(function () {
'use strict';
const { parseModel, createSim } = window.InkSim;

const $ = id => document.getElementById(id);
const els = {
  file: $('file'), loadSample: $('loadSample'), totalSteps: $('totalSteps'),
  exportJson: $('exportJson'), exportPng: $('exportPng'), verifyBtn: $('verifyBtn'),
  view: $('view'), first: $('first'), prev: $('prev'), play: $('play'), next: $('next'),
  frameInput: $('frameInput'), frameTotal: $('frameTotal'), jump: $('jump'), speed: $('speed'),
  status: $('status'), errors: $('errors'), cellInfo: $('cellInfo'),
  undo: $('undo'), redo: $('redo'), historyInfo: $('historyInfo'),
  editOps: $('editOps'), eventList: $('eventList'),
};

const SAMPLE = '{"rules":"坐标左上原点，编号为y*width+x。width、height各2到256，wrap给横纵周期布尔值。cells每条给编号i及非负整数mass、wall布尔值、出流整数w，顺序为左、右、上、下，总和至多1024，省略的格或初始字段取0或false。总质量至多2^40。events以step和i定位，给wall或w或两者，每步出流前顺序生效。墙格的质量冻结，其他格指向墙或越界的份额退回本格。相同目的地的份额相加，留存补到1024，再分配质量。每步编号从0开始，显示帧0为未执行任何一步。","width":3,"height":2,"wrap":[true,false],"cells":[{"i":0,"mass":29,"w":[256,512,0,0]},{"i":1,"mass":7,"w":[0,0,0,384]}],"events":[{"step":1,"i":2,"wall":true}]}';

let model = null, sim = null, events = [], nextSeq = 0;
let totalSteps = 600, curFrame = 0, selected = -1;
let runToken = 0, busy = false;
let undoStack = [], redoStack = [];
let playing = false, playTimer = null;
let ocv = null, octx = null; // 离屏格点画布
let baseStatus = '请加载 JSON 配置，或点击「载入示例」。';

/* ---------- 载入 ---------- */
function loadFromText(text, sourceName) {
  const { model: m, errors } = parseModel(text);
  if (errors) {
    // 非法事件/配置：指出行号，保留当前结果
    showErrors(errors.map(e => (e.line ? '行 ' + e.line : '文件') + '：' + e.msg));
    setStatus('「' + sourceName + '」含非法内容，已保留当前结果。');
    return;
  }
  showErrors([]);
  model = m;
  events = m.events.map(e => ({ ...e, w: e.w ? e.w.slice() : undefined }));
  nextSeq = events.length;
  sim = createSim(m, events);
  totalSteps = Math.max(600, m.maxEventStep + 1);
  els.totalSteps.value = totalSteps;
  els.frameTotal.textContent = totalSteps;
  curFrame = 0; selected = -1;
  undoStack = []; redoStack = [];
  ocv = document.createElement('canvas');
  ocv.width = m.width; ocv.height = m.height;
  octx = ocv.getContext('2d');
  const over = events.filter(e => e.step >= totalSteps).length;
  baseStatus = '已载入「' + sourceName + '」：' + m.width + '×' + m.height +
    '，事件 ' + events.length + ' 条' + (over ? '（其中 ' + over + ' 条超出总步数，不会生效）' : '') + '。';
  renderEventList();
  ensureFrame(0);
}

function showErrors(list) {
  els.errors.textContent = list.join('\n');
}

/* ---------- 帧调度（计算中切换以最后请求为准） ---------- */
async function ensureFrame(f) {
  if (!sim) return false;
  f = Math.max(0, Math.min(totalSteps, f | 0));
  const token = ++runToken;
  busy = true;
  if (sim.state.step > f) sim.rewindTo(f);
  while (sim.state.step < f) {
    if (token !== runToken) return false; // 已有更新的请求，作废弃
    const t0 = performance.now();
    while (sim.state.step < f && performance.now() - t0 < 16) sim.stepOnce();
    curFrame = sim.state.step;
    updateDisplay('计算中… 帧 ' + sim.state.step + ' / ' + f);
    await new Promise(r => setTimeout(r, 0));
  }
  if (token !== runToken) return false;
  busy = false;
  curFrame = f;
  updateDisplay('就绪');
  return true;
}

/* ---------- 事件编辑与撤销/重做 ---------- */
function commitEvents(newEvents, affectedStep, label) {
  undoStack.push({ events, affectedStep, label });
  if (undoStack.length > 200) undoStack.shift();
  redoStack = [];
  events = newEvents;
  rebuildSim(affectedStep);
}
function undo() {
  const e = undoStack.pop();
  if (!e) return;
  redoStack.push({ events, affectedStep: e.affectedStep, label: e.label });
  events = e.events;
  rebuildSim(e.affectedStep);
}
function redo() {
  const e = redoStack.pop();
  if (!e) return;
  undoStack.push({ events, affectedStep: e.affectedStep, label: e.label });
  events = e.events;
  rebuildSim(e.affectedStep);
}
function rebuildSim(affectedStep) {
  setPlaying(false);
  runToken++; busy = false;           // 作废弃正在进行的计算
  sim.setEvents(events, affectedStep); // 该步之后的快照与缓存全部作废
  renderEventList();
  ensureFrame(curFrame);               // 以最后请求为准重算当前帧
}

function addEvent(ev, label) {
  commitEvents(events.concat([{ ...ev, seq: nextSeq++ }]), ev.step, label);
}
function deleteEvent(seq) {
  const ev = events.find(e => e.seq === seq);
  if (!ev) return;
  commitEvents(events.filter(e => e.seq !== seq), ev.step, '删除步' + ev.step + '事件');
}

/* ---------- 渲染 ---------- */
const PAPER = [247, 243, 233], INK = [52, 72, 138], WALL = [88, 82, 76];
function draw() {
  if (!model) return;
  const W = model.width, H = model.height, N = W * H;
  const mass = sim.state.mass, wall = sim.state.wall;
  let maxM = 0;
  for (let i = 0; i < N; i++) if (mass[i] > maxM) maxM = mass[i];
  const denom = Math.log2(1 + (maxM || 1)) || 1;
  const img = octx.createImageData(W, H);
  const d = img.data;
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    if (wall[i]) {
      d[o] = WALL[0]; d[o + 1] = WALL[1]; d[o + 2] = WALL[2];
    } else {
      const t = mass[i] <= 0 ? 0 : Math.pow(Math.log2(1 + mass[i]) / denom, 0.65);
      d[o]     = PAPER[0] + (INK[0] - PAPER[0]) * t;
      d[o + 1] = PAPER[1] + (INK[1] - PAPER[1]) * t;
      d[o + 2] = PAPER[2] + (INK[2] - PAPER[2]) * t;
    }
    d[o + 3] = 255;
  }
  octx.putImageData(img, 0, 0);
  const ctx = els.view.getContext('2d');
  ctx.imageSmoothingEnabled = true; // 平滑放大，水彩晕染感
  ctx.clearRect(0, 0, els.view.width, els.view.height);
  ctx.drawImage(ocv, 0, 0, els.view.width, els.view.height);
  if (selected >= 0) {
    const cw = els.view.width / W, ch = els.view.height / H;
    const x = selected % W, y = (selected / W) | 0;
    ctx.strokeStyle = '#c2452d';
    ctx.lineWidth = 2;
    ctx.strokeRect(x * cw + 1, y * ch + 1, cw - 2, ch - 2);
  }
  return maxM;
}

function fmt(n) { return n.toLocaleString('zh-CN'); }
function fmtExact(x) {
  return Number.isInteger(x) ? String(x) : x.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function updateDisplay(statusMsg) {
  const maxM = draw();
  curFrame = sim ? sim.state.step : 0;
  els.frameInput.value = curFrame;
  els.frameInput.max = totalSteps;
  els.frameTotal.textContent = totalSteps;
  if (sim) {
    const total = sim.totalMass();
    const head = statusMsg && statusMsg !== '就绪' ? statusMsg : baseStatus;
    els.status.textContent = head +
      '　帧 ' + curFrame + ' / ' + totalSteps +
      '　总质量 ' + fmt(total) +
      '　单格最大 ' + fmt(maxM || 0);
  } else {
    els.status.textContent = statusMsg || baseStatus;
  }
  updateCellPanel();
  updateEditOps();
  els.undo.disabled = !undoStack.length;
  els.redo.disabled = !redoStack.length;
  els.historyInfo.textContent = '历史 ' + undoStack.length + ' / 重做 ' + redoStack.length;
}

function setStatus(msg) { els.status.textContent = msg; }

/* ---------- 单格明细 ---------- */
function updateCellPanel() {
  if (!sim || selected < 0) {
    els.cellInfo.innerHTML = '点击画布选择格子，查看本步分配与进出明细。';
    return;
  }
  const W = model.width;
  const x = selected % W, y = (selected / W) | 0;
  const m = sim.state.mass[selected];
  const isWall = sim.state.wall[selected];
  const w = sim.state.w;
  const b = selected * 4;
  let html = '<div class="kv"><b>格 #' + selected + '</b>（x=' + x + '，y=' + y + '）　质量 <b>' + fmt(m) + '</b>' +
    (isWall ? '　<span style="color:#a33327">墙（质量冻结）</span>' : '') + '</div>' +
    '<div class="kv">出流权重 w = [' + w[b] + ', ' + w[b + 1] + ', ' + w[b + 2] + ', ' + w[b + 3] + ']（左、右、上、下）</div>';

  const a = sim.allocDetail(selected);
  if (a.frozen) {
    html += '<div class="muted">本步该格为墙（或本步事件将其设为墙），质量冻结，不进不出。</div>';
  } else {
    html += '<h3>出流方向（本步事件生效后）</h3><table><tr><th>方向</th><th>份额</th><th>去向</th><th>备注</th></tr>';
    for (const dir of a.dirs) {
      html += '<tr><td>' + dir.name + '</td><td>' + dir.w + '</td><td>' +
        (dir.dest === null ? '—' : (dir.dest === selected && dir.w > 0 ? '本格' : '#' + dir.dest)) +
        '</td><td>' + (dir.note || '') + '</td></tr>';
    }
    html += '<tr><td>自留</td><td>' + a.stay + '</td><td>本格</td><td>1024 − 出流总和</td></tr></table>';
    html += '<h3>合并分配（总 ' + fmt(a.m) + '）</h3><table><tr><th>目的格</th><th>份额</th><th>精确值</th><th>取整</th><th>余数/1024</th><th>补</th><th>实发</th></tr>';
    for (const e of a.list) {
      html += '<tr><td>' + (e.dest === selected ? '本格' : '#' + e.dest) + '</td><td>' + e.share + '</td><td>' +
        fmtExact(e.exact) + '</td><td>' + fmt(e.floor) + '</td><td>' + e.remNum + '</td><td>' +
        (e.bonus ? '+1' : '') + '</td><td><b>' + fmt(e.amount) + '</b></td></tr>';
    }
    html += '</table>';
  }

  const inf = sim.inflowDetail(selected);
  html += '<h3>进流明细</h3>';
  if (inf.frozen) {
    html += '<div class="muted">墙格不接受进流，邻居指向本格的份额均退回邻居。</div>';
  } else if (!inf.in.length) {
    html += '<div class="muted">本步无进流。</div>';
  } else {
    html += '<table><tr><th>来源格</th><th>份额</th><th>入量</th></tr>';
    for (const e of inf.in) {
      html += '<tr><td>' + (e.self ? '本格（自留/退回）' : '#' + e.from) + '</td><td>' + e.share + '</td><td><b>' + fmt(e.amount) + '</b></td></tr>';
    }
    html += '</table>';
  }

  const mine = events.filter(e => e.i === selected);
  if (mine.length) {
    html += '<h3>该格事件</h3><div class="muted">' +
      mine.map(e => '步' + e.step + '：' + evDesc(e)).join('；') + '</div>';
  }
  els.cellInfo.innerHTML = html;
}

function evDesc(e) {
  const parts = [];
  if (e.wall !== undefined) parts.push('wall→' + e.wall);
  if (e.w) parts.push('w→[' + e.w.join(',') + ']');
  return parts.join('，');
}

/* ---------- 事件编辑面板 ---------- */
function updateEditOps() {
  if (!sim || selected < 0) {
    els.editOps.innerHTML = '<span class="muted">选中格子后，可在指定步对其加墙 / 拆墙 / 设置流向。</span>';
    return;
  }
  els.editOps.innerHTML =
    '<div class="row">对格 <b>#' + selected + '</b>，步 <input type="number" id="editStep" min="0" max="' +
    (totalSteps - 1) + '" value="' + Math.min(curFrame, totalSteps - 1) + '">：</div>' +
    '<div class="row"><button id="opWall">加墙</button><button id="opUnwall" class="secondary">拆墙</button>' +
    '<button id="opFlow" class="secondary">设置流向</button></div>';
  $('opWall').onclick = () => addEvent({ step: editStep(), i: selected, wall: true }, '加墙');
  $('opUnwall').onclick = () => addEvent({ step: editStep(), i: selected, wall: false }, '拆墙');
  $('opFlow').onclick = () => {
    const s = prompt('输入出流权重「左,右,上,下」（非负整数，总和 ≤ 1024）：', '256,256,256,256');
    if (s === null) return;
    const parts = s.split(/[,，\s]+/).filter(Boolean).map(Number);
    if (parts.length !== 4 || parts.some(v => !Number.isInteger(v) || v < 0)) {
      alert('须为 4 个非负整数'); return;
    }
    if (parts.reduce((x, y) => x + y, 0) > 1024) {
      alert('总和须 ≤ 1024'); return;
    }
    addEvent({ step: editStep(), i: selected, w: parts }, '设置流向');
  };
}
function editStep() {
  const v = parseInt($('editStep').value, 10);
  return Number.isInteger(v) && v >= 0 ? Math.min(v, totalSteps - 1) : 0;
}

function renderEventList() {
  const MAX_ROWS = 300;
  let html = '<div class="muted">共 ' + events.length + ' 条事件' +
    (events.length > MAX_ROWS ? '（仅显示前 ' + MAX_ROWS + ' 条）' : '') + '</div>';
  const sorted = events.slice().sort((a, b) => a.step - b.step || a.seq - b.seq);
  for (const e of sorted.slice(0, MAX_ROWS)) {
    html += '<div class="evrow"><span>步 ' + e.step + '　格 #' + e.i + '　' + evDesc(e) +
      '</span><button class="secondary" data-seq="' + e.seq + '">删除</button></div>';
  }
  els.eventList.innerHTML = html;
  els.eventList.querySelectorAll('button[data-seq]').forEach(btn => {
    btn.onclick = () => deleteEvent(Number(btn.dataset.seq));
  });
}

/* ---------- 播放 ---------- */
function setPlaying(p) {
  playing = p;
  els.play.textContent = p ? '⏸' : '▶';
  clearInterval(playTimer);
  if (p) {
    playTimer = setInterval(() => {
      if (busy) return;
      if (curFrame >= totalSteps) { setPlaying(false); return; }
      ensureFrame(curFrame + 1);
    }, 1000 / Number(els.speed.value));
  }
}

/* ---------- 导出与校验 ---------- */
function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function exportJson() {
  if (!sim) return;
  const { mass, wall, w } = sim.state;
  const cells = [];
  for (let i = 0; i < model.N; i++) {
    const ws = [w[i * 4], w[i * 4 + 1], w[i * 4 + 2], w[i * 4 + 3]];
    if (mass[i] > 0 || wall[i] || ws.some(v => v > 0)) {
      const c = { i, mass: mass[i] };
      if (wall[i]) c.wall = true;
      if (ws.some(v => v > 0)) c.w = ws;
      cells.push(c);
    }
  }
  const obj = { step: curFrame, width: model.width, height: model.height, wrap: [model.wrapH, model.wrapV], cells };
  download('ink-frame-' + curFrame + '.json', new Blob([JSON.stringify(obj)], { type: 'application/json' }));
}
function exportPng() {
  if (!sim) return;
  const scale = Math.max(1, Math.floor(1024 / Math.max(model.width, model.height)));
  const c = document.createElement('canvas');
  c.width = model.width * scale; c.height = model.height * scale;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(ocv, 0, 0, c.width, c.height);
  c.toBlob(b => download('ink-frame-' + curFrame + '.png', b), 'image/png');
}
function verifyFrame() {
  if (!sim) return;
  setStatus('校验中：从开头按当前事件表重算到帧 ' + curFrame + '…');
  setTimeout(() => {
    const fresh = createSim(model, events);
    while (fresh.state.step < curFrame) fresh.stepOnce();
    let same = true;
    for (let i = 0; i < model.N; i++) {
      if (fresh.state.mass[i] !== sim.state.mass[i]) { same = false; break; }
    }
    setStatus(same ?
      '校验通过：当前帧与从开头重算完全一致。' :
      '校验失败：当前帧与重算不一致（请报告此问题）。');
  }, 30);
}

/* ---------- 事件绑定 ---------- */
els.file.addEventListener('change', () => {
  const f = els.file.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => loadFromText(String(r.result), f.name);
  r.readAsText(f);
  els.file.value = '';
});
els.loadSample.addEventListener('click', () => {
  fetch('samples/ink-flux.json')
    .then(r => { if (!r.ok) throw new Error(); return r.text(); })
    .then(t => loadFromText(t, 'samples/ink-flux.json'))
    .catch(() => loadFromText(SAMPLE, '内置示例'));
});
els.totalSteps.addEventListener('change', () => {
  const v = parseInt(els.totalSteps.value, 10);
  if (!Number.isInteger(v) || v < 1) { els.totalSteps.value = totalSteps; return; }
  totalSteps = Math.min(5000, v);
  els.totalSteps.value = totalSteps;
  if (sim) ensureFrame(Math.min(curFrame, totalSteps));
});
els.first.addEventListener('click', () => ensureFrame(0));
els.prev.addEventListener('click', () => ensureFrame(curFrame - 1));
els.next.addEventListener('click', () => ensureFrame(curFrame + 1));
els.jump.addEventListener('click', () => ensureFrame(parseInt(els.frameInput.value, 10) || 0));
els.frameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') ensureFrame(parseInt(els.frameInput.value, 10) || 0);
});
els.play.addEventListener('click', () => setPlaying(!playing));
els.speed.addEventListener('change', () => { if (playing) setPlaying(true); });
els.undo.addEventListener('click', undo);
els.redo.addEventListener('click', redo);
els.exportJson.addEventListener('click', exportJson);
els.exportPng.addEventListener('click', exportPng);
els.verifyBtn.addEventListener('click', verifyFrame);

els.view.addEventListener('click', e => {
  if (!model) return;
  const r = els.view.getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left) / r.width * model.width);
  const y = Math.floor((e.clientY - r.top) / r.height * model.height);
  if (x < 0 || y < 0 || x >= model.width || y >= model.height) return;
  selected = y * model.width + x;
  updateDisplay();
});
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); if (sim) setPlaying(!playing); }
  else if (e.key === 'ArrowRight') ensureFrame(curFrame + 1);
  else if (e.key === 'ArrowLeft') ensureFrame(curFrame - 1);
});
})();
