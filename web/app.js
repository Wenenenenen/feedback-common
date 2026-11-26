// 对版台交互逻辑（ESM）
const $ = (id) => document.getElementById(id);

const state = {
  masterArr: null,
  deliveryArr: null,
  settings: null,
  locks: [],          // [{i,j}]
  result: null,       // 最近一次有效结果
  exportData: null,
  selected: { master: -1, delivery: -1 },
  // 由结果派生的逐帧标注
  masterTag: null,    // 每帧 'm' | 'x'
  deliveryTag: null,  // 每帧 'm' | 'y'
  matchOfMaster: null, // 主版帧 -> 交付帧（仅配对）
  matchOfDelivery: null,
};

const ROW_H = 28;
const worker = new Worker('./worker.js', { type: 'module' });

// ---------- 导入 ----------
async function readJson(file) {
  const text = await file.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file.name} 不是合法 JSON`);
  }
}

function bindFile(inputId, labelId, kind) {
  $(inputId).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = await readJson(file);
      if (kind === 'settings') {
        state.settings = data;
        $(labelId).classList.add('loaded');
        $(labelId).firstChild.textContent = `${file.name} `;
        applySettingsInputs(data);
        toast(`已载入设置：${file.name}`, 'info');
      } else {
        if (!Array.isArray(data)) throw new Error(`${file.name} 顶层必须是指纹数组`);
        if (kind === 'master') state.masterArr = data;
        else state.deliveryArr = data;
        $(labelId).classList.add('loaded');
        $(labelId).firstChild.textContent = `${file.name}（${data.length} 帧） `;
        toast(`已载入 ${kind === 'master' ? '主版' : '交付版'} ${data.length} 帧`, 'info');
      }
      refreshAlignButton();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}
bindFile('masterFile', 'masterLabel', 'master');
bindFile('deliveryFile', 'deliveryLabel', 'delivery');
bindFile('settingsFile', 'settingsLabel', 'settings');

function applySettingsInputs(s) {
  if (s == null) return;
  if (s.maxDistance != null) $('setMaxD').value = s.maxDistance;
  if (s.gapOpen != null) $('setOpen').value = s.gapOpen;
  if (s.gapExtend != null) $('setExt').value = s.gapExtend;
}
function collectSettings() {
  const out = {};
  const md = parseInt($('setMaxD').value, 10);
  const op = parseInt($('setOpen').value, 10);
  const ex = parseInt($('setExt').value, 10);
  if (Number.isInteger(md)) out.maxDistance = md;
  if (Number.isInteger(op)) out.gapOpen = op;
  if (Number.isInteger(ex)) out.gapExtend = ex;
  return Object.keys(out).length ? out : state.settings;
}
function refreshAlignButton() {
  $('alignBtn').disabled = !(state.masterArr && state.deliveryArr);
}

// ---------- worker 接线 ----------
worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'progress') {
    $('progressBar').style.width = `${Math.round(msg.progress * 100)}%`;
    return;
  }
  hideProgress();
  if (msg.type === 'done') {
    state.result = msg.result;
    state.exportData = msg.export;
    state.locks = msg.result.locks.map((l) => ({ ...l }));
    buildAnnotations();
    renderAll();
    $('exportBtn').disabled = false;
    $('clearLockBtn').disabled = state.locks.length === 0;
    toast(`对齐完成：费用 ${msg.result.totalFee}，缺多段 ${msg.result.gapSegments}`, 'ok');
  } else if (msg.type === 'error') {
    handleAlignError(msg);
  }
};

function handleAlignError(msg) {
  // 保留上一次有效结果与锁点；指出阻断位置
  let detail = msg.message;
  if (msg.at) detail += `（位置 主版帧 ${msg.at.i} / 交付帧 ${msg.at.j}）`;
  if (msg.segment) {
    const s = msg.segment;
    detail += `｜阻断区间 #${s.index}：(${s.from.i},${s.from.j}) → (${s.to.i},${s.to.j})`;
  }
  if (msg.hasLastResult) {
    detail += '｜已保留上一次有效结果与锁点。';
    state.locks = msg.lastLocks.map((l) => ({ ...l }));
    $('clearLockBtn').disabled = state.locks.length === 0;
    renderAll();
  } else {
    toast(detail, 'error');
    return;
  }
  toast(detail, 'error');
}

$('alignBtn').addEventListener('click', () => {
  if (!state.masterArr || !state.deliveryArr) return;
  showProgress('正在对齐…');
  worker.postMessage({
    type: 'align',
    masterArr: state.masterArr,
    deliveryArr: state.deliveryArr,
    settingsRaw: collectSettings(),
    locks: state.locks.map((l) => ({ ...l })),
  });
});

$('clearLockBtn').addEventListener('click', () => {
  state.locks = [];
  $('clearLockBtn').disabled = true;
  buildAnnotations();
  renderAll();
  toast('已清空全部锁点，再次“开始对齐”生效', 'info');
});

// ---------- 导出 ----------
$('exportBtn').addEventListener('click', () => {
  if (!state.exportData) return;
  const blob = new Blob([JSON.stringify(state.exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'alignment-export.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ---------- 结果派生标注 ----------
function buildAnnotations() {
  const r = state.result;
  if (!r) {
    state.masterTag = state.deliveryTag = null;
    state.matchOfMaster = state.matchOfDelivery = null;
    return;
  }
  const n = state.masterArr.length;
  const m = state.deliveryArr.length;
  state.masterTag = new Array(n).fill(null);
  state.deliveryTag = new Array(m).fill(null);
  state.matchOfMaster = new Array(n).fill(-1);
  state.matchOfDelivery = new Array(m).fill(-1);
  for (const st of r.steps) {
    if (st.t === 'm') {
      state.masterTag[st.ai] = 'm';
      state.deliveryTag[st.bi] = 'm';
      state.matchOfMaster[st.ai] = st.bi;
      state.matchOfDelivery[st.bi] = st.ai;
    } else if (st.t === 'x') {
      state.masterTag[st.ai] = 'x';
    } else {
      state.deliveryTag[st.bi] = 'y';
    }
  }
}

// ---------- 锁点交互 ----------
function lockSet() {
  return new Set(state.locks.map((l) => `${l.i},${l.j}`));
}
function isMasterLocked(i) {
  return state.locks.some((l) => l.i === i);
}
function isDeliveryLocked(j) {
  return state.locks.some((l) => l.j === j);
}

function onRowClick(side, index) {
  state.selected[side] = index;
  attemptLock();
  renderRows();
}

function attemptLock() {
  const mSel = state.selected.master;
  const dSel = state.selected.delivery;
  if (mSel < 0 || dSel < 0) return;
  const existing = state.locks.find((l) => l.i === mSel && l.j === dSel);
  if (existing) {
    state.locks = state.locks.filter((l) => l !== existing);
    toast(`撤锁 (${mSel},${dSel})，再次“开始对齐”生效`, 'info');
  } else {
    // 客户端预检，给出即时反馈；权威校验仍在 worker
    const reason = preValidateLock(mSel, dSel);
    if (reason) { toast(reason, 'error'); state.selected = { master: -1, delivery: -1 }; return; }
    state.locks.push({ i: mSel, j: dSel });
    toast(`加锁 (${mSel},${dSel})，再次“开始对齐”生效`, 'info');
  }
  state.selected = { master: -1, delivery: -1 };
  $('clearLockBtn').disabled = state.locks.length === 0;
}

function preValidateLock(i, j) {
  if (state.locks.some((l) => l.i === i)) return `主版帧 ${i} 已锁给别的目标，先撤锁`;
  if (state.locks.some((l) => l.j === j)) return `交付帧 ${j} 已锁给别的目标，先撤锁`;
  if (Math.abs(i - j) > 64) return `锁点 (${i},${j}) 越带：|i-j|=${Math.abs(i - j)}>64`;
  return null;
}

// ---------- 虚拟滚动双轨 ----------
const scrolls = { master: $('masterScroll'), delivery: $('deliveryScroll') };
let syncing = false;

function rowCount(side) {
  return side === 'master'
    ? (state.masterArr ? state.masterArr.length : 0)
    : (state.deliveryArr ? state.deliveryArr.length : 0);
}

function renderRows() {
  renderSide('master');
  renderSide('delivery');
}

function renderSide(side) {
  const scrollEl = scrolls[side];
  const total = rowCount(side);
  const arr = side === 'master' ? state.masterArr : state.deliveryArr;
  const rowsEl = side === 'master' ? $('masterRows') : $('deliveryRows');
  const topEl = side === 'master' ? $('masterSpacerTop') : $('deliverySpacerTop');
  const botEl = side === 'master' ? $('masterSpacerBottom') : $('deliverySpacerBottom');
  const infoEl = side === 'master' ? $('masterScrollInfo') : $('deliveryScrollInfo');
  if (!arr) {
    rowsEl.innerHTML = '';
    topEl.style.height = '0px';
    botEl.style.height = '0px';
    infoEl.textContent = '';
    return;
  }
  const viewH = scrollEl.clientHeight || 480;
  const scrollTop = scrollEl.scrollTop;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 8);
  const visible = Math.ceil(viewH / ROW_H) + 16;
  const last = Math.min(total, first + visible);
  topEl.style.height = `${first * ROW_H}px`;
  botEl.style.height = `${Math.max(0, total - last) * ROW_H}px`;

  const tags = side === 'master' ? state.masterTag : state.deliveryTag;
  const html = [];
  for (let k = first; k < last; k++) {
    const fp = arr[k] ?? '';
    const tag = tags ? tags[k] : null;
    const locked = side === 'master' ? isMasterLocked(k) : isDeliveryLocked(k);
    const selected = state.selected[side] === k;
    const cls = ['row'];
    if (selected) cls.push('selected');
    if (locked) cls.push('locked');
    const tagText = tag === 'm' ? '配对' : tag === 'x' ? '缺帧' : tag === 'y' ? '多帧' : '';
    const tagCls = tag || '';
    html.push(
      `<div class="${cls.join(' ')}" data-side="${side}" data-index="${k}">
        <span class="idx">${k}</span>
        <span class="fp" title="${fp}">${fp}</span>
        <span class="tag ${tagCls}">${locked ? '🔒 ' : ''}${tagText}</span>
      </div>`,
    );
  }
  rowsEl.innerHTML = html.join('');
  infoEl.textContent = `${first}–${last} / ${total}`;
}

// 事件委托
scrolls.master.addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (row) onRowClick('master', parseInt(row.dataset.index, 10));
});
scrolls.delivery.addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (row) onRowClick('delivery', parseInt(row.dataset.index, 10));
});

// 滚动同步
function linkScroll(a, b) {
  a.addEventListener('scroll', () => {
    if (syncing) return;
    syncing = true;
    b.scrollTop = a.scrollTop;
    requestAnimationFrame(() => { syncing = false; });
    renderRows();
  });
}
linkScroll(scrolls.master, scrolls.delivery);
linkScroll(scrolls.delivery, scrolls.master);
new ResizeObserver(() => renderRows()).observe(scrolls.master);
new ResizeObserver(() => renderRows()).observe(scrolls.delivery);

// ---------- 差异条 ----------
function renderDiffStrip() {
  const strip = $('diffstrip');
  strip.innerHTML = '';
  const r = state.result;
  if (!r || !r.intervals.length) {
    strip.style.display = 'none';
    return;
  }
  strip.style.display = 'block';
  const total = Math.max(state.masterArr.length, state.deliveryArr.length);
  for (const iv of r.intervals) {
    const seg = document.createElement('div');
    seg.className = `diff-seg ${iv.type}`;
    const leftPct = (iv.start / total) * 100;
    const widthPct = Math.max(0.4, ((iv.end - iv.start) / total) * 100);
    seg.style.left = `${leftPct}%`;
    seg.style.width = `${widthPct}%`;
    seg.dataset.interval = JSON.stringify(iv);
    strip.appendChild(seg);
  }
}

const tooltip = $('diffTooltip');
$('diffstrip').addEventListener('mousemove', (e) => {
  const seg = e.target.closest('.diff-seg');
  if (!seg) { tooltip.style.display = 'none'; return; }
  const iv = JSON.parse(seg.dataset.interval);
  tooltip.style.display = 'block';
  tooltip.style.left = `${e.clientX + 12}px`;
  tooltip.style.top = `${e.clientY + 12}px`;
  const sideName = iv.type === 'missing' ? '主版' : '交付版';
  tooltip.textContent =
    `${iv.type === 'missing' ? '缺帧' : '多帧'}：${sideName}帧 ${iv.start}–${iv.end - 1}（半开 [${iv.start},${iv.end})），对侧已消费 ${iv.otherConsumed}`;
});
$('diffstrip').addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });

$('diffstrip').addEventListener('click', (e) => {
  const seg = e.target.closest('.diff-seg');
  if (!seg) return;
  const iv = JSON.parse(seg.dataset.interval);
  jumpToInterval(iv);
});

// 跳到区间首帧及其对侧边界（边界可在轨尾）
function jumpToInterval(iv) {
  let masterFrame;
  let deliveryFrame;
  if (iv.type === 'missing') {
    masterFrame = iv.start;
    deliveryFrame = Math.min(iv.otherConsumed, state.deliveryArr.length - 1);
  } else {
    deliveryFrame = iv.start;
    masterFrame = Math.min(iv.otherConsumed, state.masterArr.length - 1);
  }
  scrollToFrame('master', masterFrame);
  scrollToFrame('delivery', deliveryFrame);
  state.selected = { master: -1, delivery: -1 };
  renderRows();
}

function scrollToFrame(side, frame) {
  const el = scrolls[side];
  el.scrollTop = Math.max(0, frame * ROW_H - ROW_H * 4);
}

// ---------- 状态栏 ----------
function renderStatus() {
  $('statN').textContent = state.masterArr ? state.masterArr.length : '–';
  $('statM').textContent = state.deliveryArr ? state.deliveryArr.length : '–';
  const r = state.result;
  $('statFee').textContent = r ? r.totalFee : '–';
  $('statSeg').textContent = r ? r.gapSegments : '–';
  $('statMatch').textContent = r ? r.steps.filter((s) => s.t === 'm').length : '–';
  $('statLock').textContent = state.locks.length;
}

function renderAll() {
  buildAnnotations();
  renderStatus();
  renderDiffStrip();
  renderRows();
}

// ---------- 通用 UI ----------
function showProgress(text) {
  $('progressText').textContent = text;
  $('progressBar').style.width = '0';
  $('progressMask').classList.add('show');
}
function hideProgress() {
  $('progressMask').classList.remove('show');
}
let toastTimer = null;
function toast(message, kind = 'info') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 5200);
}

// 初始渲染
renderAll();
