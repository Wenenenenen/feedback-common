'use strict';
/* 气泡轨迹核对台
 * 规则（samples/约定.txt）：
 *  - 事件：续接(1对1,相邻帧)、跨帧(1对1,隔一帧)、分裂(1对2)、合并(2对1)
 *  - 同侧双对象质心曼哈顿距离 ≤ D；跨侧面积加权质心曼哈顿距离 ≤ D×帧差
 *  - 相对面积差 = |Δ面积|/较大面积，1对1 ≤ 0.5，分合 ≤ 0.25
 *  - 事件费用 = round-half-up(10×距离 + 20×相对面积差) + 分合费/跳帧费
 *  - 每个对象有至多一个入槽、一个出槽；未用槽收入场费/退场费（首末帧也计）
 *  - 总费用最小；平局按候选编号 0/1 选择向量字典序取最小（0 在 1 前）
 *  - 候选按（源对象列表, 目标对象列表）字典序编号，对象键 = (帧号, 标签)
 * 全部费用用 BigInt 分数精确计算，避免浮点舍入误差。
 */

// ---------------- 状态 ----------------
const state = {
  W: 0, H: 0,
  frames: [],        // Uint16Array 数组
  names: [],
  params: { D: 8, birth: 40, death: 40, splitMerge: 3, gap: 5 },
  objects: new Map(),   // "f,label" -> {f,label,area,sx,sy,cx,cy}
  frameLabels: [],      // 每帧排序后的标签数组
  candidates: [],
  groups: [],           // {id, ids:[候选编号], size, solved, reason}
  solution: null,       // {selected:Set, total, eventSum, births:[], deaths:[], unsolved:[]}
  locks: new Set(),
  excludes: new Set(),
  forceSolve: new Set(),   // 组签名（首候选编号）-> 强制求解
  selObj: null,         // "f,label"
  selCand: null,
  curFrame: 0,
  groupFilter: null,    // 组 id
  messages: [],
};

const $ = (id) => document.getElementById(id);
const keyOf = (f, l) => f + ',' + l;
const TYPE_NAME = { link: '续接', gap: '跨帧', split: '分裂', merge: '合并' };
const MAX_FRAMES = 24, MAX_DIM = 256, MAX_LABELS = 24, GROUP_LIMIT = 32;
const DFS_BUDGET = 5e6, DFS_BUDGET_FORCE = 5e7;

// ---------------- 消息 ----------------
function setMessages(list) {
  state.messages = list;
  const box = $('messages');
  box.innerHTML = '';
  for (const m of list) {
    const div = document.createElement('div');
    div.className = 'msg ' + m.kind;
    div.textContent = m.text;
    if (m.group != null) {
      const b = document.createElement('button');
      b.textContent = '定位到该组';
      b.onclick = () => locateGroup(m.group);
      div.appendChild(b);
    }
    if (m.forceSig != null) {
      const b = document.createElement('button');
      b.textContent = '仍要强制求解';
      b.onclick = () => { state.forceSolve.add(m.forceSig); solveAndRender(); };
      div.appendChild(b);
    }
    box.appendChild(div);
  }
}

// ---------------- 文件导入 ----------------
async function inflateRaw(buf, kind) {
  const ds = new DecompressionStream(kind);
  const stream = new Blob([buf]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZip(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  // 找 EOCD
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0 && i >= u8.length - 22 - 65536; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('ZIP 目录损坏');
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nlen = dv.getUint16(off + 28, true);
    const elen = dv.getUint16(off + 30, true);
    const clen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(u8.subarray(off + 46, off + 46 + nlen));
    const lnlen = dv.getUint16(lho + 26, true);
    const lelen = dv.getUint16(lho + 28, true);
    const dataOff = lho + 30 + lnlen + lelen;
    const raw = u8.slice(dataOff, dataOff + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = await inflateRaw(raw, 'deflate-raw');
    else throw new Error('不支持的 ZIP 压缩方式: ' + method);
    out.set(name.split('/').pop(), data);
    off += 46 + nlen + elen + clen;
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// 解码 8/16 位灰度 PNG（非隔行），返回 {w,h,pix:Uint16Array}
async function decodePng(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0) !== 0x89504e47) throw new Error('不是 PNG 文件');
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < dv.byteLength) {
    const len = dv.getUint32(off);
    const type = dv.getUint32(off + 4);
    if (type === 0x49484452) { // IHDR
      w = dv.getUint32(off + 8); h = dv.getUint32(off + 12);
      bitDepth = dv.getUint8(off + 16); colorType = dv.getUint8(off + 17);
      interlace = dv.getUint8(off + 20);
    } else if (type === 0x49444154) { // IDAT
      idat.push(buf.slice(off + 8, off + 8 + len));
    }
    off += 12 + len;
  }
  if (colorType !== 0) throw new Error('仅支持灰度 PNG（colorType=0）');
  if (bitDepth !== 8 && bitDepth !== 16) throw new Error('仅支持 8/16 位 PNG');
  if (interlace !== 0) throw new Error('不支持隔行扫描 PNG');
  const packed = new Uint8Array(await new Response(
    new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'))
  ).arrayBuffer());
  const bpp = bitDepth / 8, stride = w * bpp;
  const raw = new Uint8Array(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = packed[p++];
    const row = raw.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? raw.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const v = packed[p++];
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= bpp) ? prev[x - bpp] : 0;
      let r;
      switch (filter) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: r = v + paeth(a, b, c); break;
        default: throw new Error('未知 PNG 滤波器 ' + filter);
      }
      row[x] = r & 0xff;
    }
  }
  const pix = new Uint16Array(w * h);
  if (bitDepth === 16) {
    for (let i = 0; i < w * h; i++) pix[i] = (raw[2 * i] << 8) | raw[2 * i + 1]; // PNG 大端
  } else {
    for (let i = 0; i < w * h; i++) pix[i] = raw[i];
  }
  return { w, h, pix };
}

async function importEntries(entries) {
  // entries: Map 文件名 -> Uint8Array
  const errs = [];
  let meta = null;
  for (const [name, data] of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const j = JSON.parse(new TextDecoder().decode(data));
      if (j && Array.isArray(j.files)) { meta = j; break; } // 取第一个含 files 的 json
    } catch (e) { errs.push('JSON 解析失败: ' + name); }
  }
  const params = readParamForm();
  let W, H, files;
  if (meta && meta.files) {
    W = meta.w; H = meta.h; files = meta.files;
    for (const k of ['D', 'birth', 'death', 'splitMerge', 'gap']) {
      if (typeof meta[k] === 'number') params[k] = meta[k];
    }
  } else {
    files = [...entries.keys()].filter(n => n.endsWith('.png') || n.endsWith('.u16')).sort();
    W = parseInt($('pW').value, 10); H = parseInt($('pH').value, 10);
  }
  if (files.length === 0) throw new Error('没有找到帧图文件（.u16 / .png）');
  if (files.length > MAX_FRAMES) throw new Error('帧数超过上限 ' + MAX_FRAMES + '（共 ' + files.length + '）');

  const frames = [], names = [];
  for (const f of files) {
    const data = entries.get(f);
    if (!data) throw new Error('缺少帧图文件: ' + f);
    if (f.endsWith('.png')) {
      const png = await decodePng(data);
      if (meta && meta.files) { if (png.w !== W || png.h !== H) throw new Error(f + ' 尺寸与配置不一致'); }
      else { W = png.w; H = png.h; }
      frames.push(png.pix); names.push(f);
    } else {
      if (!W || !H) throw new Error('缺少宽高配置（.u16 需要 meta json 或手动填写宽高）');
      if (data.length !== W * H * 2) throw new Error(f + ' 字节数(' + data.length + ')与 ' + W + '×' + H + '×2 不符');
      const pix = new Uint16Array(W * H);
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (let i = 0; i < W * H; i++) pix[i] = dv.getUint16(2 * i, true); // 小端
      frames.push(pix); names.push(f);
    }
  }
  if (!W || !H || W > MAX_DIM || H > MAX_DIM) throw new Error('帧尺寸非法或超过 ' + MAX_DIM + '×' + MAX_DIM);
  // 校验同尺寸（png 无 meta 时以首帧为准）
  applyData(W, H, frames, names, params, errs);
}

function applyData(W, H, frames, names, params, warns) {
  state.W = W; state.H = H; state.frames = frames; state.names = names;
  state.params = params;
  state.locks.clear(); state.excludes.clear(); state.forceSolve.clear();
  state.selObj = null; state.selCand = null; state.curFrame = 0; state.groupFilter = null;
  // 提取对象
  state.objects.clear(); state.frameLabels = [];
  const msgs = warns.map(t => ({ kind: 'warn', text: t }));
  for (let f = 0; f < frames.length; f++) {
    const acc = new Map();
    const pix = frames[f];
    for (let i = 0; i < pix.length; i++) {
      const v = pix[i];
      if (!v) continue;
      let o = acc.get(v);
      if (!o) { o = { area: 0, sx: 0, sy: 0 }; acc.set(v, o); }
      o.area++; o.sx += i % W; o.sy += (i / W) | 0;
    }
    if (acc.size > MAX_LABELS) {
      msgs.push({ kind: 'error', text: '第 ' + f + ' 帧有 ' + acc.size + ' 个非零标签，超过上限 ' + MAX_LABELS });
    }
    const labels = [...acc.keys()].sort((a, b) => a - b);
    state.frameLabels.push(labels);
    for (const [lab, o] of acc) {
      state.objects.set(keyOf(f, lab), {
        f, label: lab, area: o.area, sx: o.sx, sy: o.sy,
        cx: o.sx / o.area, cy: o.sy / o.area,
      });
    }
  }
  // 同步参数表单
  $('pD').value = params.D; $('pBirth').value = params.birth; $('pDeath').value = params.death;
  $('pSplitMerge').value = params.splitMerge; $('pGap').value = params.gap;
  $('pW').value = W; $('pH').value = H;
  $('btnRecalc').disabled = false;
  $('btnExport').disabled = false;
  const slider = $('frameSlider');
  slider.max = frames.length - 1; slider.value = 0;
  solveAndRender(msgs);
}

function readParamForm() {
  return {
    D: Math.round(+$('pD').value), birth: +$('pBirth').value, death: +$('pDeath').value,
    splitMerge: +$('pSplitMerge').value, gap: +$('pGap').value,
  };
}

// ---------------- 候选生成（精确分数） ----------------
function genCandidates() {
  const { D, splitMerge, gap } = state.params;
  const F = state.frames.length;
  const objs = state.objects;
  const cands = [];
  const get = (k) => objs.get(k);

  // 每帧标签对的同侧质心距离（精确）：pairOk[f] = [[la,lb],...]
  const pairOk = [];
  for (let f = 0; f < F; f++) {
    const labs = state.frameLabels[f];
    const pairs = [];
    for (let i = 0; i < labs.length; i++) {
      const A = get(keyOf(f, labs[i]));
      for (let j = i + 1; j < labs.length; j++) {
        const B = get(keyOf(f, labs[j]));
        const num = BigInt(Math.abs(A.sx * B.area - B.sx * A.area) + Math.abs(A.sy * B.area - B.sy * A.area));
        const den = BigInt(A.area * B.area);
        if (num <= BigInt(D) * den) pairs.push([labs[i], labs[j]]);
      }
    }
    pairOk.push(pairs);
  }

  // 合并侧统计：返回 [area, sx, sy]（整数和）
  function combine(keys) {
    let a = 0, x = 0, y = 0;
    for (const k of keys) { const o = get(k); a += o.area; x += o.sx; y += o.sy; }
    return [a, x, y];
  }

  function tryEvent(srcKeys, tgtKeys, type, fee) {
    const df = tgtKeys[0].split(',')[0] - srcKeys[0].split(',')[0];
    const [a1, x1, y1] = combine(srcKeys);
    const [a2, x2, y2] = combine(tgtKeys);
    // 浮点预筛
    const dF = Math.abs(x1 / a1 - x2 / a2) + Math.abs(y1 / a1 - y2 / a2);
    if (dF > D * df + 1e-9) return;
    const rF = Math.abs(a1 - a2) / Math.max(a1, a2);
    const lim = type === 'link' || type === 'gap' ? 0.5 : 0.25;
    if (rF > lim + 1e-12) return;
    // 精确校验
    const dNum = BigInt(Math.abs(x1 * a2 - x2 * a1) + Math.abs(y1 * a2 - y2 * a1));
    const dDen = BigInt(a1 * a2);
    if (dNum > BigInt(D * df) * dDen) return;
    const rNum = BigInt(Math.abs(a1 - a2)), rDen = BigInt(Math.max(a1, a2));
    if (type === 'link' || type === 'gap') { if (2n * rNum > rDen) return; }
    else { if (4n * rNum > rDen) return; }
    // 费用 = round-half-up(10d + 20r)，floor(v + 1/2)
    const vNum = 10n * dNum * rDen + 20n * rNum * dDen;
    const vDen = dDen * rDen;
    const cost = Number((2n * vNum + vDen) / (2n * vDen)) + fee;
    cands.push({
      src: srcKeys.slice().sort(), tgt: tgtKeys.slice().sort(),
      type, dist: dF, areaDiff: rF, fee, cost,
    });
  }

  for (let f = 0; f < F; f++) {
    const labs = state.frameLabels[f];
    // 续接（df=1）与跨帧（df=2）
    for (const [df, fee, type] of [[1, 0, 'link'], [2, gap, 'gap']]) {
      if (f + df >= F) continue;
      for (const la of labs) {
        for (const lb of state.frameLabels[f + df]) {
          tryEvent([keyOf(f, la)], [keyOf(f + df, lb)], type, fee);
        }
      }
    }
    // 分裂与合并（df=1）
    if (f + 1 < F) {
      for (const la of labs) {
        for (const [b1, b2] of pairOk[f + 1]) {
          tryEvent([keyOf(f, la)], [keyOf(f + 1, b1), keyOf(f + 1, b2)], 'split', splitMerge);
        }
      }
      for (const [a1, a2] of pairOk[f]) {
        for (const lb of state.frameLabels[f + 1]) {
          tryEvent([keyOf(f, a1), keyOf(f, a2)], [keyOf(f + 1, lb)], 'merge', splitMerge);
        }
      }
    }
  }

  // 编号：按（源列表, 目标列表）字典序，对象键 (帧, 标签)
  const cmpKeys = (a, b) => {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const [fa, la] = a[i].split(',').map(Number);
      const [fb, lb] = b[i].split(',').map(Number);
      if (fa !== fb) return fa - fb;
      if (la !== lb) return la - lb;
    }
    return a.length - b.length;
  };
  cands.sort((p, q) => cmpKeys(p.src, q.src) || cmpKeys(p.tgt, q.tgt));
  cands.forEach((c, i) => { c.id = i; });
  return cands;
}

// ---------------- 求解 ----------------
function solve() {
  const cands = state.candidates;
  const n = cands.length;
  const { birth, death } = state.params;
  const msgs = [];
  state.groups = [];
  state._lockForced = new Map();

  // 槽位映射
  const outSlot = new Map(), inSlot = new Map();
  cands.forEach((c, i) => {
    for (const k of c.src) { (outSlot.get(k) || outSlot.set(k, []).get(k)).push(i); }
    for (const k of c.tgt) { (inSlot.get(k) || inSlot.set(k, []).get(k)).push(i); }
  });
  // 冲突邻接
  const conf = Array.from({ length: n }, () => new Set());
  const addConf = (lst) => { for (const i of lst) for (const j of lst) if (i !== j) conf[i].add(j); };
  for (const lst of outSlot.values()) addConf(lst);
  for (const lst of inSlot.values()) addConf(lst);

  // 共享槽位描述（用于冲突提示）
  function sharedSlots(i, j) {
    const a = cands[i], b = cands[j], out = [];
    for (const k of a.src) if (b.src.includes(k)) out.push({ key: k, slot: '出槽' });
    for (const k of a.tgt) if (b.tgt.includes(k)) out.push({ key: k, slot: '入槽' });
    return out;
  }
  state._conf = conf; state._sharedSlots = sharedSlots;

  // 锁定冲突检查
  const lockArr = [...state.locks];
  const lockErrs = [];
  for (let i = 0; i < lockArr.length; i++) {
    for (let j = i + 1; j < lockArr.length; j++) {
      if (conf[lockArr[i]].has(lockArr[j])) {
        for (const s of sharedSlots(lockArr[i], lockArr[j])) {
          lockErrs.push('锁定冲突：候选 #' + lockArr[i] + ' 与 #' + lockArr[j] +
            ' 争用对象 ' + fmtKey(s.key) + ' 的' + s.slot);
        }
      }
    }
  }
  if (lockErrs.length) return { msgs: lockErrs.map(t => ({ kind: 'error', text: t })) };

  // 固定值：锁定=1，排除=0，与锁定冲突的自由候选=0
  const fixed = new Map();
  for (const i of state.locks) fixed.set(i, 1);
  for (const i of state.excludes) fixed.set(i, 0);
  const lockForced = new Map(); // i -> 造成排除的锁定候选
  for (const i of state.locks) {
    for (const j of conf[i]) {
      if (!fixed.has(j)) { fixed.set(j, 0); lockForced.set(j, i); }
    }
  }
  state._lockForced = lockForced;

  // delta = 事件费用 -（源侧退场费 + 目标侧入场费）
  const delta = cands.map(c => c.cost - death * c.src.length - birth * c.tgt.length);

  // 自由候选的连通组
  const free = [];
  for (let i = 0; i < n; i++) if (!fixed.has(i)) free.push(i);
  const freeSet = new Set(free);
  const seen = new Set();
  const groups = [];
  for (const s of free) {
    if (seen.has(s)) continue;
    const comp = [];
    const stack = [s]; seen.add(s);
    while (stack.length) {
      const u = stack.pop(); comp.push(u);
      for (const v of conf[u]) {
        if (freeSet.has(v) && !seen.has(v)) { seen.add(v); stack.push(v); }
      }
    }
    comp.sort((a, b) => a - b);
    groups.push({ ids: comp, sig: String(comp[0]) });
  }
  groups.sort((a, b) => a.ids[0] - b.ids[0]);
  groups.forEach((g, gi) => { g.id = gi; g.size = g.ids.length; });

  const selected = new Set(state.locks);
  let totalDelta = 0;
  for (const i of state.locks) totalDelta += delta[i];
  const unsolved = [];

  for (const g of groups) {
    g.solved = false;
    if (g.size > GROUP_LIMIT && !state.forceSolve.has(g.sig)) {
      g.reason = '该组有 ' + g.size + ' 个候选互相争用槽位（超过 ' + GROUP_LIMIT + '），请锁定或排除部分候选后重算';
      unsolved.push(g);
      msgs.push({ kind: 'warn', text: '第 ' + (g.id + 1) + ' 组：' + g.reason, group: g.id, forceSig: g.sig });
      continue;
    }
    const budget = g.size > GROUP_LIMIT ? DFS_BUDGET_FORCE : DFS_BUDGET;
    const res = solveGroup(g.ids, conf, delta, budget);
    if (res == null) {
      g.reason = '求解超出计算预算，请锁定或排除部分候选';
      unsolved.push(g);
      msgs.push({ kind: 'warn', text: '第 ' + (g.id + 1) + ' 组：' + g.reason, group: g.id });
      continue;
    }
    g.solved = true;
    totalDelta += res.cost;
    for (const i of res.picked) selected.add(i);
  }

  // 入场/退场
  const births = [], deaths = [];
  for (const k of state.objects.keys()) {
    const usedIn = (inSlot.get(k) || []).some(i => selected.has(i));
    const usedOut = (outSlot.get(k) || []).some(i => selected.has(i));
    if (!usedIn) births.push(k);
    if (!usedOut) deaths.push(k);
  }
  const base = state.objects.size * (birth + death);
  const total = base + totalDelta;
  const eventSum = [...selected].reduce((s, i) => s + cands[i].cost, 0);

  state.groups = groups;
  return {
    msgs,
    solution: { selected, total, eventSum, births, deaths, unsolved, lockForced },
  };
}

// 单组分支定界：0 分支优先 => 首个达到最小费用的完整向量即字典序最小
function solveGroup(ids, conf, delta, budget) {
  const m = ids.length;
  const confBits = new Array(m).fill(0n);
  for (let p = 0; p < m; p++) {
    let bits = 0n;
    for (let q = 0; q < m; q++) {
      if (p !== q && conf[ids[p]].has(ids[q])) bits |= (1n << BigInt(q));
    }
    confBits[p] = bits;
  }
  const suffixNeg = new Array(m + 1).fill(0);
  for (let p = m - 1; p >= 0; p--) suffixNeg[p] = suffixNeg[p + 1] + Math.min(0, delta[ids[p]]);
  let best = Infinity, bestMask = 0n, steps = 0, aborted = false;

  function dfs(p, base, mask) {
    if (aborted) return;
    if (++steps > budget) { aborted = true; return; }
    if (base + suffixNeg[p] >= best) return; // 平局取先到的（字典序更小）
    if (p === m) { best = base; bestMask = mask; return; }
    dfs(p + 1, base, mask);                 // 0 分支
    if ((confBits[p] & mask) === 0n) {
      dfs(p + 1, base + delta[ids[p]], mask | (1n << BigInt(p))); // 1 分支
    }
  }
  dfs(0, 0, 0n);
  if (aborted) return null;
  const picked = [];
  for (let p = 0; p < m; p++) if ((bestMask >> BigInt(p)) & 1n) picked.push(ids[p]);
  return { cost: best === Infinity ? 0 : best, picked };
}

// ---------------- 未选原因 ----------------
function candStatus(i) {
  const c = state.candidates[i];
  const sol = state.solution;
  if (state.locks.has(i)) return { tag: 'locked', text: '已锁定' };
  if (state.excludes.has(i)) return { tag: 'excluded', text: '已排除（用户）' };
  if (!sol) return { tag: '', text: '未求解（存在锁定冲突）' };
  if (sol.selected.has(i)) return { tag: 'selected', text: '已选' };
  if (state._lockForced && state._lockForced.has(i)) {
    return { tag: 'forced0', text: '与锁定候选 #' + state._lockForced.get(i) + ' 冲突' };
  }
  const g = state.groups.find(g => g.ids.includes(i));
  if (g && !g.solved) return { tag: 'unsolved', text: '所在第 ' + (g.id + 1) + ' 组未求解（' + g.reason + '）' };
  // 与已选候选冲突
  const confSel = [...state._conf[i]].filter(j => sol.selected.has(j));
  if (confSel.length) {
    const parts = confSel.map(j =>
      state._sharedSlots(i, j).map(s => '对象 ' + fmtKey(s.key) + ' 的' + s.slot).join('、')
    );
    return {
      tag: 'conflict',
      text: '与已选候选 ' + confSel.map(j => '#' + j).join('、') + ' 争用 ' + parts.join('；'),
    };
  }
  const { birth, death } = state.params;
  const d = c.cost - death * c.src.length - birth * c.tgt.length;
  if (d > 0) return { tag: 'costly', text: '选用它将使总费用 +' + d };
  return { tag: 'tie', text: '费用持平，按平局规则（0 在 1 前）未选' };
}

// ---------------- 渲染 ----------------
function fmtKey(k) {
  const [f, l] = k.split(',');
  return 'F' + f + '·L' + l;
}
function fmtKeys(keys) { return keys.map(fmtKey).join(' + '); }
function labelColor(label) { return 'hsl(' + ((label * 137.5) % 360) + ' 65% 55%)'; }

function solveAndRender(extraMsgs) {
  if (!state.frames.length) return;
  state.candidates = genCandidates();
  const { msgs, solution } = solve();
  state.solution = solution || null;
  setMessages([...(extraMsgs || []), ...(msgs || [])]);
  renderAll();
}

function renderAll() {
  renderTotal(); renderFrame(); renderGraph(); renderTable(); renderObjInfo();
}

function renderTotal() {
  const sol = state.solution;
  if (!sol) { $('totalBox').textContent = ''; return; }
  const p = state.params;
  let t = '总费用 ' + sol.total +
    '（事件 ' + sol.eventSum + ' + 入场 ' + sol.births.length + '×' + p.birth +
    ' + 退场 ' + sol.deaths.length + '×' + p.death + '）';
  if (sol.unsolved.length) t += '　⚠ 有 ' + sol.unsolved.length + ' 组未求解，总费用不完整';
  $('totalBox').textContent = t;
}

// ---- 帧图 ----
const frameCanvas = $('frameCanvas');
const fctx = frameCanvas.getContext('2d');
let frameScale = 4;

function renderFrame() {
  const { W, H, frames, curFrame } = state;
  if (!frames.length) return;
  const pix = frames[curFrame];
  const off = document.createElement('canvas');
  off.width = W; off.height = H;
  const octx = off.getContext('2d');
  const img = octx.createImageData(W, H);
  for (let i = 0; i < pix.length; i++) {
    const v = pix[i];
    const o = 4 * i;
    if (!v) { img.data[o + 3] = 255; img.data[o] = 16; img.data[o + 1] = 18; img.data[o + 2] = 22; continue; }
    const hsl = (v * 137.5) % 360;
    const [r, g, b] = hslToRgb(hsl / 360, 0.65, 0.55);
    img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
  }
  octx.putImageData(img, 0, 0);
  frameScale = Math.max(2, Math.floor(512 / Math.max(W, H)));
  frameCanvas.width = W * frameScale;
  frameCanvas.height = H * frameScale;
  fctx.imageSmoothingEnabled = false;
  fctx.drawImage(off, 0, 0, frameCanvas.width, frameCanvas.height);

  // 高亮：当前组涉及对象 + 选中对象
  const hl = new Set();
  if (state.groupFilter != null) {
    const g = state.groups[state.groupFilter];
    if (g) for (const i of g.ids) {
      for (const k of [...state.candidates[i].src, ...state.candidates[i].tgt]) hl.add(k);
    }
  }
  for (const k of hl) drawObjBox(k, '#d29922', 2);
  if (state.selObj) drawObjBox(state.selObj, '#ffffff', 2);

  $('frameLabel').textContent = '帧 ' + curFrame + ' / ' + (frames.length - 1) +
    '（' + state.names[curFrame] + '）';
  $('frameSlider').value = curFrame;
}

function drawObjBox(key, color, lw) {
  const [f, l] = key.split(',').map(Number);
  if (f !== state.curFrame) return;
  const { W, frames } = state;
  const pix = frames[f];
  let x0 = W, x1 = -1, y0 = Infinity, y1 = -1;
  for (let i = 0; i < pix.length; i++) {
    if (pix[i] === l) {
      const x = i % W, y = (i / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return;
  fctx.strokeStyle = color; fctx.lineWidth = lw;
  fctx.strokeRect(x0 * frameScale - 1, y0 * frameScale - 1,
    (x1 - x0 + 1) * frameScale + 2, (y1 - y0 + 1) * frameScale + 2);
}

function hslToRgb(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

function renderObjInfo() {
  const el = $('objInfo');
  if (!state.selObj) { el.textContent = '未选择对象'; return; }
  const o = state.objects.get(state.selObj);
  if (!o) { el.textContent = '未选择对象'; return; }
  const sol = state.solution;
  let inTxt = '入场(+' + state.params.birth + ')', outTxt = '退场(+' + state.params.death + ')';
  if (sol) {
    for (const i of sol.selected) {
      const c = state.candidates[i];
      if (c.tgt.includes(state.selObj)) inTxt = '入：' + TYPE_NAME[c.type] + ' 候选#' + i + '（费用 ' + c.cost + '）';
      if (c.src.includes(state.selObj)) outTxt = '出：' + TYPE_NAME[c.type] + ' 候选#' + i + '（费用 ' + c.cost + '）';
    }
  }
  el.textContent = fmtKey(state.selObj) + '　面积 ' + o.area +
    '　质心 (' + o.cx.toFixed(2) + ', ' + o.cy.toFixed(2) + ')　' + inTxt + '　' + outTxt;
}

// ---- 轨迹图 ----
function renderGraph() {
  const svg = $('graphSvg');
  const { frames, objects, candidates, solution } = state;
  if (!frames.length) { svg.innerHTML = ''; return; }
  const F = frames.length;
  const colW = 90, padX = 40, padY = 24, H = 380;
  const Wpx = padX * 2 + (F - 1) * colW;
  svg.setAttribute('width', Wpx);
  svg.setAttribute('height', H + padY * 2);
  svg.innerHTML = '';
  const ns = 'http://www.w3.org/2000/svg';
  const yOf = (o) => padY + (o.cy + 0.5) / state.H * H;
  const xOf = (f) => padX + f * colW;

  // 帧分隔线与帧号
  for (let f = 0; f < F; f++) {
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', xOf(f)); t.setAttribute('y', 14);
    t.setAttribute('fill', '#8b96a5'); t.setAttribute('font-size', '11');
    t.setAttribute('text-anchor', 'middle'); t.textContent = 'F' + f;
    svg.appendChild(t);
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', xOf(f)); line.setAttribute('x2', xOf(f));
    line.setAttribute('y1', padY); line.setAttribute('y2', padY + H);
    line.setAttribute('stroke', '#262d38');
    svg.appendChild(line);
  }

  const edgeColors = { link: '#7d8794', gap: '#4da3ff', split: '#3fb950', merge: '#d29922' };
  const drawEdge = (c, i, selectedEdge) => {
    const srcO = c.src.map(k => objects.get(k));
    const tgtO = c.tgt.map(k => objects.get(k));
    const cx1 = srcO.reduce((s, o) => s + xOf(o.f), 0) / srcO.length;
    const cy1 = srcO.reduce((s, o) => s + yOf(o), 0) / srcO.length;
    const cx2 = tgtO.reduce((s, o) => s + xOf(o.f), 0) / tgtO.length;
    const cy2 = tgtO.reduce((s, o) => s + yOf(o), 0) / tgtO.length;
    const p = document.createElementNS(ns, 'path');
    const mx = (cx1 + cx2) / 2;
    p.setAttribute('d', 'M' + cx1 + ',' + cy1 + ' C' + mx + ',' + cy1 + ' ' + mx + ',' + cy2 + ' ' + cx2 + ',' + cy2);
    p.setAttribute('fill', 'none');
    p.setAttribute('class', 'edge');
    if (selectedEdge) {
      p.setAttribute('stroke', edgeColors[c.type]);
      p.setAttribute('stroke-width', '2.2');
    } else {
      p.setAttribute('stroke', '#5a6472');
      p.setAttribute('stroke-width', '1');
      p.setAttribute('stroke-dasharray', '4 3');
      p.setAttribute('opacity', '0.45');
    }
    const title = document.createElementNS(ns, 'title');
    title.textContent = '#' + i + ' ' + TYPE_NAME[c.type] + ' ' + fmtKeys(c.src) + ' → ' + fmtKeys(c.tgt) + ' 费用 ' + c.cost;
    p.appendChild(title);
    p.addEventListener('click', () => { state.selCand = i; renderTable(); renderDetail(); });
    svg.appendChild(p);
  };

  if (solution) for (const i of solution.selected) drawEdge(candidates[i], i, true);
  if ($('chkCands').checked && solution) {
    let drawn = 0;
    for (const c of candidates) {
      if (solution.selected.has(c.id)) continue;
      if (drawn++ > 3000) break;
      drawEdge(c, c.id, false);
    }
  }

  // 节点
  const hlGroup = state.groupFilter != null ? state.groups[state.groupFilter] : null;
  const hlObjs = new Set();
  if (hlGroup) for (const i of hlGroup.ids) {
    for (const k of [...candidates[i].src, ...candidates[i].tgt]) hlObjs.add(k);
  }
  for (const [k, o] of objects) {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', xOf(o.f)); c.setAttribute('cy', yOf(o));
    c.setAttribute('r', k === state.selObj ? 8 : 6);
    c.setAttribute('fill', labelColor(o.label));
    c.setAttribute('class', 'node');
    if (k === state.selObj) { c.setAttribute('stroke', '#fff'); c.setAttribute('stroke-width', '2'); }
    else if (hlObjs.has(k)) { c.setAttribute('stroke', '#d29922'); c.setAttribute('stroke-width', '2'); }
    const title = document.createElementNS(ns, 'title');
    title.textContent = fmtKey(k) + ' 面积 ' + o.area;
    c.appendChild(title);
    c.addEventListener('click', () => {
      state.selObj = k; state.curFrame = o.f;
      renderFrame(); renderGraph(); renderObjInfo();
    });
    svg.appendChild(c);
  }
}

// ---- 候选表 ----
function renderTable() {
  const tbody = $('candTable').querySelector('tbody');
  tbody.innerHTML = '';
  const filter = $('candFilter').value;
  const sol = state.solution;
  let list = state.candidates.map(c => c.id);
  if (filter === 'selected' && sol) list = list.filter(i => sol.selected.has(i));
  else if (filter === 'unselected' && sol) list = list.filter(i => !sol.selected.has(i));
  else if (filter === 'locked') list = list.filter(i => state.locks.has(i));
  else if (filter === 'excluded') list = list.filter(i => state.excludes.has(i));
  else if (filter === 'group' && state.groupFilter != null) {
    const g = state.groups[state.groupFilter];
    list = g ? g.ids.slice() : [];
  }
  const total = list.length;
  const CAP = 500;
  const capped = list.length > CAP;
  if (capped) list = list.slice(0, CAP);
  $('candCount').textContent = '共 ' + total + ' 项' + (capped ? '（仅显示前 ' + CAP + '）' : '') +
    '　候选总数 ' + state.candidates.length;

  for (const i of list) {
    const c = state.candidates[i];
    const st = candStatus(i);
    const tr = document.createElement('tr');
    if (sol && sol.selected.has(i)) tr.classList.add('sel');
    if (state.locks.has(i)) tr.classList.add('locked');
    if (state.excludes.has(i)) tr.classList.add('excluded');
    if (state.selCand === i) tr.style.outline = '1px solid var(--accent)';
    const cells = [
      '#' + i, TYPE_NAME[c.type], fmtKeys(c.src), fmtKeys(c.tgt),
      c.dist.toFixed(2), c.areaDiff.toFixed(3), String(c.cost), st.text,
    ];
    for (const t of cells) {
      const td = document.createElement('td'); td.textContent = t; tr.appendChild(td);
    }
    const td = document.createElement('td');
    const mk = (txt, fn) => {
      const b = document.createElement('button');
      b.className = 'mini'; b.textContent = txt;
      b.onclick = (e) => { e.stopPropagation(); fn(); };
      return b;
    };
    td.appendChild(mk(state.locks.has(i) ? '解锁' : '锁定', () => {
      state.locks.has(i) ? state.locks.delete(i) : (state.locks.add(i), state.excludes.delete(i));
      solveAndRender();
    }));
    td.appendChild(mk(state.excludes.has(i) ? '恢复' : '排除', () => {
      state.excludes.has(i) ? state.excludes.delete(i) : (state.excludes.add(i), state.locks.delete(i));
      solveAndRender();
    }));
    tr.appendChild(td);
    tr.onclick = () => {
      state.selCand = i;
      state.selObj = c.src[0];
      state.curFrame = +c.src[0].split(',')[0];
      renderFrame(); renderGraph(); renderObjInfo(); renderTable(); renderDetail();
    };
    tbody.appendChild(tr);
  }
  renderDetail();
}

function renderDetail() {
  const el = $('candDetail');
  const i = state.selCand;
  if (i == null || !state.candidates[i]) { el.hidden = true; return; }
  const c = state.candidates[i];
  const st = candStatus(i);
  const { birth, death } = state.params;
  const d = c.cost - death * c.src.length - birth * c.tgt.length;
  let html = '<h3>候选 #' + i + '　' + TYPE_NAME[c.type] + '　' + fmtKeys(c.src) + ' → ' + fmtKeys(c.tgt) + '</h3>';
  html += '<div class="kv">距离 ' + c.dist.toFixed(3) + '（上限 D×帧差），相对面积差 ' + c.areaDiff.toFixed(4) +
    '，附加费 ' + c.fee + '　→　事件费用 <b>' + c.cost + '</b>　相对全入场/退场方案的 Δ = ' + (d >= 0 ? '+' : '') + d + '</div>';
  html += '<div>状态：<b>' + st.text + '</b></div>';
  const confs = [...state._conf[i]].sort((a, b) => a - b);
  if (confs.length) {
    html += '<div class="kv">争用槽位的候选（' + confs.length + '）：</div>';
    for (const j of confs.slice(0, 30)) {
      const slots = state._sharedSlots(i, j).map(s => fmtKey(s.key) + ' 的' + s.slot).join('、');
      const jst = candStatus(j);
      const badge = state.solution && state.solution.selected.has(j) ? '<span class="badge sel">已选</span>' : '';
      html += '<div class="conf-item">' + badge + '<a href="#" data-cand="' + j + '">#' + j + '</a> ' +
        TYPE_NAME[state.candidates[j].type] + '（费用 ' + state.candidates[j].cost + '）— 争用 ' + slots + '</div>';
    }
    if (confs.length > 30) html += '<div class="kv">… 其余 ' + (confs.length - 30) + ' 项从略</div>';
  } else {
    html += '<div class="kv">无槽位争用。</div>';
  }
  el.innerHTML = html;
  el.hidden = false;
  el.querySelectorAll('a[data-cand]').forEach(a => {
    a.onclick = (e) => {
      e.preventDefault();
      const j = +a.dataset.cand;
      state.selCand = j;
      state.selObj = state.candidates[j].src[0];
      state.curFrame = +state.candidates[j].src[0].split(',')[0];
      renderFrame(); renderGraph(); renderObjInfo(); renderTable(); renderDetail();
    };
  });
}

// ---------------- 组定位 ----------------
function locateGroup(gid) {
  state.groupFilter = gid;
  $('candFilter').value = 'group';
  const g = state.groups[gid];
  if (g && g.ids.length) {
    const c = state.candidates[g.ids[0]];
    state.selObj = c.src[0];
    state.curFrame = +c.src[0].split(',')[0];
  }
  renderFrame(); renderGraph(); renderObjInfo(); renderTable();
  document.getElementById('candPane').scrollIntoView({ behavior: 'smooth' });
}

// ---------------- 导出 ----------------
function exportJson() {
  const sol = state.solution;
  if (!sol) return;
  const p = state.params;
  const events = [...sol.selected].sort((a, b) => a - b).map(i => {
    const c = state.candidates[i];
    return {
      candidate: i, type: c.type,
      sources: c.src.map(k => k.split(',').map(Number)),
      targets: c.tgt.map(k => k.split(',').map(Number)),
      cost: c.cost, locked: state.locks.has(i),
    };
  });
  const out = {
    params: { w: state.W, h: state.H, frames: state.frames.length, ...p },
    total: sol.total,
    eventCostSum: sol.eventSum,
    birthCount: sol.births.length,
    deathCount: sol.deaths.length,
    events,
    births: sol.births.map(k => k.split(',').map(Number)),
    deaths: sol.deaths.map(k => k.split(',').map(Number)),
    selectedCandidateIds: [...sol.selected].sort((a, b) => a - b),
    candidates: state.candidates.map(c => ({
      id: c.id, type: c.type,
      sources: c.src.map(k => k.split(',').map(Number)),
      targets: c.tgt.map(k => k.split(',').map(Number)),
      distance: +c.dist.toFixed(6), areaDiff: +c.areaDiff.toFixed(6),
      fee: c.fee, cost: c.cost,
      selected: sol.selected.has(c.id),
      locked: state.locks.has(c.id),
      excluded: state.excludes.has(c.id),
      group: (state.groups.find(g => g.ids.includes(c.id)) || {}).id ?? null,
    })),
    unsolvedGroups: sol.unsolved.map(g => ({ group: g.id, size: g.size, reason: g.reason })),
  };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'bubble-lineage.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------- 事件绑定 ----------------
$('btnImport').onclick = () => $('fileInput').click();
$('fileInput').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  try {
    let entries;
    if (files.length === 1 && files[0].name.endsWith('.zip')) {
      entries = await readZip(await files[0].arrayBuffer());
    } else {
      entries = new Map();
      for (const f of files) entries.set(f.name, new Uint8Array(await f.arrayBuffer()));
    }
    await importEntries(entries);
  } catch (err) {
    setMessages([{ kind: 'error', text: '导入失败：' + err.message }]);
  }
};

$('btnSample').onclick = async () => {
  try {
    const resp = await fetch('samples/bubble-lineage-cases.zip');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const entries = await readZip(await resp.arrayBuffer());
    // 样例包含 flow 与 choice 两组，默认载入 flow
    const flow = new Map();
    for (const [k, v] of entries) if (k.startsWith('flow')) flow.set(k, v);
    await importEntries(flow);
    setMessages([{ kind: 'ok', text: '已载入样例 flow（4 帧）。choice 组请通过导入 ZIP 后选择对应文件查看。' },
      ...state.messages]);
  } catch (err) {
    setMessages([{ kind: 'error', text: '载入样例失败（file:// 下无法读取，请用 http 服务或手动导入 ZIP）：' + err.message }]);
  }
};

$('btnRecalc').onclick = () => {
  if (!state.frames.length) return;
  state.params = readParamForm();
  state.forceSolve.clear();
  solveAndRender();
};
$('btnExport').onclick = exportJson;

$('btnPrev').onclick = () => { if (state.curFrame > 0) { state.curFrame--; renderFrame(); } };
$('btnNext').onclick = () => {
  if (state.curFrame < state.frames.length - 1) { state.curFrame++; renderFrame(); }
};
$('frameSlider').oninput = (e) => { state.curFrame = +e.target.value; renderFrame(); };
$('chkCands').onchange = renderGraph;
$('candFilter').onchange = renderTable;

frameCanvas.addEventListener('mousemove', (e) => {
  if (!state.frames.length) return;
  const rect = frameCanvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) / rect.width * state.W);
  const y = Math.floor((e.clientY - rect.top) / rect.height * state.H);
  const tip = $('frameTip');
  if (x < 0 || y < 0 || x >= state.W || y >= state.H) { tip.hidden = true; return; }
  const lab = state.frames[state.curFrame][y * state.W + x];
  if (!lab) { tip.hidden = true; return; }
  const o = state.objects.get(keyOf(state.curFrame, lab));
  tip.textContent = fmtKey(keyOf(state.curFrame, lab)) + ' 面积 ' + o.area +
    ' 质心(' + o.cx.toFixed(1) + ',' + o.cy.toFixed(1) + ')';
  tip.style.left = (e.clientX - rect.left + 12) + 'px';
  tip.style.top = (e.clientY - rect.top + 12) + 'px';
  tip.hidden = false;
});
frameCanvas.addEventListener('mouseleave', () => { $('frameTip').hidden = true; });
frameCanvas.addEventListener('click', (e) => {
  if (!state.frames.length) return;
  const rect = frameCanvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) / rect.width * state.W);
  const y = Math.floor((e.clientY - rect.top) / rect.height * state.H);
  if (x < 0 || y < 0 || x >= state.W || y >= state.H) return;
  const lab = state.frames[state.curFrame][y * state.W + x];
  if (!lab) return;
  state.selObj = keyOf(state.curFrame, lab);
  renderFrame(); renderGraph(); renderObjInfo();
});
