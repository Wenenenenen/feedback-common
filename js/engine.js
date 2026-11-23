// L21P / CEA-608 子集状态机引擎（无 DOM 依赖，可在 Worker 与 Node 中运行）
// 约定见 samples/extracted/约定.txt

export const STATUS = {
  OK: 0,          // 正常执行（文本/控制/PAC/NOP）
  BAD_PARITY: 1,  // 奇校验错误，整对丢弃
  IGNORED: 2,     // 未支持的对，忽略
  SUPPRESSED: 3,  // 重复控制，按场抑制
};

export const STATUS_LABEL = ['执行', '坏校验丢弃', '忽略', '重复抑制'];

const ROWS = 15;
const COLS = 32;
const GRID_SIZE = ROWS * COLS;

// PAC 行号表：index = 2*(A&7) + ((B>>5)&1)，0 表示未支持
const PAC_ROW_TABLE = [11, 0, 1, 2, 3, 4, 12, 13, 14, 15, 5, 6, 7, 8, 9, 10];

// 奇校验查表：true 表示该字节最高位奇校验正确（含最高位共奇数个 1）
const PARITY_OK = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let c = 0, x = i;
  while (x) { c += x & 1; x >>= 1; }
  PARITY_OK[i] = c & 1;
}

export function oddParity(b7) {
  // 给定低 7 位，返回带正确奇校验的字节
  let c = 0, x = b7 & 0x7f;
  let y = x;
  while (y) { c += y & 1; y >>= 1; }
  return (c & 1) ? x : (x | 0x80);
}

export function isTextLow7(v) {
  return v === 0x00 || v === 0x20 || (v >= 0x41 && v <= 0x5a);
}

function isControlA(a) { return a === 0x14 || a === 0x1c; }
function isPacRange(a, b) { return a >= 0x10 && a <= 0x1f && b >= 0x40 && b <= 0x7f; }

const CONTROL_NAMES = {
  0x20: '弹出模式(RCL)',
  0x29: '直写模式(PAON)',
  0x21: '退格(BS)',
  0x24: '清到行末(EDM)',
  0x2c: '清显示(CD)',
  0x2e: '清后备(CBD)',
  0x2f: '交换网格(SW)',
  0x25: '2行滚动(RU2)',
  0x26: '3行滚动(RU3)',
  0x27: '4行滚动(RU4)',
  0x2d: '上卷一行(CR)',
};

function newGrid() { return new Uint8Array(GRID_SIZE); }

// ---- 状态创建 ----
export function createState() {
  const channels = [];
  for (let c = 0; c < 4; c++) {
    channels.push({
      mode: 'pop',          // pop | paint | roll
      curRow: 15,
      curCol: 1,
      baseRow: 15,
      rollRows: 2,
      back: newGrid(),
      display: newGrid(),
    });
  }
  const fields = [];
  for (let f = 0; f < 2; f++) {
    fields.push({ lastFrame: -1, candA: -1, candB: -1, current: 0 });
  }
  return { channels, fields };
}

function cloneGrid(g) { return g.slice(); }

// 检查点：深拷贝全部状态（含两场重复候选、四通道双网格）
export function takeCheckpoint(state, recordIndex) {
  return {
    recordIndex,
    fields: state.fields.map(f => ({ ...f })),
    channels: state.channels.map(ch => ({
      mode: ch.mode,
      curRow: ch.curRow,
      curCol: ch.curCol,
      baseRow: ch.baseRow,
      rollRows: ch.rollRows,
      back: cloneGrid(ch.back),
      display: cloneGrid(ch.display),
    })),
  };
}

export function restoreCheckpoint(state, cp) {
  for (let f = 0; f < 2; f++) Object.assign(state.fields[f], cp.fields[f]);
  for (let c = 0; c < 4; c++) {
    const s = state.channels[c], p = cp.channels[c];
    s.mode = p.mode;
    s.curRow = p.curRow; s.curCol = p.curCol;
    s.baseRow = p.baseRow; s.rollRows = p.rollRows;
    s.back = cloneGrid(p.back);
    s.display = cloneGrid(p.display);
  }
}

function targetGrid(ch) {
  return ch.mode === 'pop' ? ch.back : ch.display;
}

function idx(row, col) { return (row - 1) * COLS + (col - 1); }

function writeCell(ch, value) {
  const g = targetGrid(ch);
  g[idx(ch.curRow, ch.curCol)] = value;
  if (ch.curCol < COLS) ch.curCol++; // 列32饱和，再写覆盖
}

function backspace(ch) {
  if (ch.curCol === 1) return;
  ch.curCol--;
  targetGrid(ch)[idx(ch.curRow, ch.curCol)] = 0;
}

function eraseToEndOfRow(ch) {
  const g = targetGrid(ch);
  const base = idx(ch.curRow, ch.curCol);
  const rowEnd = ch.curRow * COLS;
  for (let i = base; i < rowEnd; i++) g[i] = 0;
}

function clearGrid(g) { g.fill(0); }

function enterRoll(ch, rows) {
  if (ch.mode !== 'roll') {
    // 进入滚动：清两网格，基行与游标归位
    clearGrid(ch.back);
    clearGrid(ch.display);
    ch.mode = 'roll';
    ch.rollRows = rows;
    ch.baseRow = 15;
    ch.curRow = 15;
    ch.curCol = 1;
  } else {
    // 已在滚动：调整高度，保留仍在新窗口内的行
    ch.rollRows = rows;
    const top = ch.baseRow - rows + 1;
    for (let r = 1; r < top; r++) {
      const base = (r - 1) * COLS;
      for (let i = 0; i < COLS; i++) ch.display[base + i] = 0;
    }
    if (ch.curRow < top) { ch.curRow = top; ch.curCol = 1; }
    if (ch.curRow > ch.baseRow) { ch.curRow = ch.baseRow; ch.curCol = 1; }
  }
}

function rollUp(ch) {
  // 仅滚动时：窗口整体上卷一行，顶行丢弃，基行清空，游标回首列
  const top = ch.baseRow - ch.rollRows + 1;
  for (let r = top; r < ch.baseRow; r++) {
    const dst = (r - 1) * COLS;
    const src = r * COLS;
    for (let i = 0; i < COLS; i++) ch.display[dst + i] = ch.display[src + i];
  }
  const baseStart = (ch.baseRow - 1) * COLS;
  for (let i = 0; i < COLS; i++) ch.display[baseStart + i] = 0;
  ch.curRow = ch.baseRow;
  ch.curCol = 1;
}

function applyPac(ch, a, b) {
  const rowIndex = 2 * (a & 0x07) + ((b >> 5) & 1);
  const row = PAC_ROW_TABLE[rowIndex];
  if (row === 0) return false; // 未支持
  let col = 1;
  if ((b & 0x10) !== 0) col = 1 + 4 * (b & 0x07);

  if (ch.mode === 'roll') {
    // 改基行：整网内容按相对基行偏移正向搬迁，落在新窗口（夹在 1..15）内才保留，越界丢弃
    const delta = row - ch.baseRow;
    if (delta !== 0) {
      const snap = cloneGrid(ch.display);
      clearGrid(ch.display);
      const newTop = Math.max(1, row - ch.rollRows + 1);
      const newBottom = Math.min(ROWS, row);
      for (let oldR = 1; oldR <= ROWS; oldR++) {
        const newR = oldR + delta;
        if (newR >= newTop && newR <= newBottom) {
          const src = (oldR - 1) * COLS;
          const dst = (newR - 1) * COLS;
          for (let i = 0; i < COLS; i++) ch.display[dst + i] = snap[src + i];
        }
      }
    }
    ch.baseRow = row;
  }
  ch.curRow = row;
  ch.curCol = col;
  return true;
}

function applyControl(ch, b) {
  switch (b) {
    case 0x20: ch.mode = 'pop'; return;
    case 0x29: ch.mode = 'paint'; return;
    case 0x21: backspace(ch); return;
    case 0x24: eraseToEndOfRow(ch); return;
    case 0x2c: clearGrid(ch.display); return;
    case 0x2e: clearGrid(ch.back); return;
    case 0x2f:
      { const t = ch.back; ch.back = ch.display; ch.display = t;
        ch.mode = 'pop'; ch.curRow = 15; ch.curCol = 1; return; }
    case 0x25: enterRoll(ch, 2); return;
    case 0x26: enterRoll(ch, 3); return;
    case 0x27: enterRoll(ch, 4); return;
    case 0x2d: if (ch.mode === 'roll') rollUp(ch); return;
    default: return;
  }
}

// ---- 单条记录演算 ----
// doc: { frames, fields, rawA, rawB, statuses }（均为类型化数组）
// i: 记录下标；state: 可变状态
export function stepRecord(doc, i, state) {
  const frame = doc.frames[i];
  const fieldIdx = doc.fields[i] - 1;
  const fs = state.fields[fieldIdx];

  // 缺帧（含场首帧）打断重复检测
  if (fs.lastFrame !== frame - 1) { fs.candA = -1; fs.candB = -1; }
  fs.lastFrame = frame;

  const rawA = doc.rawA[i];
  const rawB = doc.rawB[i];

  if (!PARITY_OK[rawA] || !PARITY_OK[rawB]) {
    doc.statuses[i] = STATUS.BAD_PARITY; // 坏校验丢整对
    fs.candA = -1; fs.candB = -1;
    return;
  }

  const a = rawA & 0x7f;
  const b = rawB & 0x7f;

  if (isTextLow7(a) && isTextLow7(b)) {
    // 文本：写当前通道（0x00 为空操作，写 0 等于无可见效果）
    const ch = state.channels[fieldIdx * 2 + fs.current];
    if (a !== 0) writeCell(ch, a);
    if (b !== 0) writeCell(ch, b);
    doc.statuses[i] = STATUS.OK;
    fs.candA = -1; fs.candB = -1; // 文本打断重复检测
    return;
  }

  if (isControlA(a) || isPacRange(a, b)) {
    // 重复抑制：仅本场上一帧刚执行过相同字节对
    if (fs.candA === a && fs.candB === b) {
      doc.statuses[i] = STATUS.SUPPRESSED;
      fs.candA = -1; fs.candB = -1; // 抑制后清掉重复候选
      return;
    }
    const channelIndex = fieldIdx * 2 + ((a >> 3) & 1);
    const ch = state.channels[channelIndex];
    let supported = true;
    if (isControlA(a)) {
      if (b in CONTROL_NAMES) applyControl(ch, b);
      else supported = false;
    } else {
      supported = applyPac(ch, a, b);
    }
    if (!supported) {
      doc.statuses[i] = STATUS.IGNORED;
      fs.candA = -1; fs.candB = -1; // 忽略打断重复检测
      return;
    }
    fs.current = (a >> 3) & 1; // 处理后该通道成为当前通道
    doc.statuses[i] = STATUS.OK;
    fs.candA = a; fs.candB = b;
    return;
  }

  // 未支持的对
  doc.statuses[i] = STATUS.IGNORED;
  fs.candA = -1; fs.candB = -1;
}

// ---- 全量演算 + 检查点 ----
// 每 interval 条记录存一个检查点（含 0 号），保证任意跳帧最多重放 interval 条
export function simulate(doc, interval = 10000, onProgress) {
  const state = createState();
  const checkpoints = [takeCheckpoint(state, 0)];
  const n = doc.frames.length;
  for (let i = 0; i < n; i++) {
    stepRecord(doc, i, state);
    if ((i + 1) % interval === 0 && i + 1 < n) {
      checkpoints.push(takeCheckpoint(state, i + 1));
    }
    if (onProgress && (i & 0xffff) === 0) onProgress(i + 1, n);
  }
  return { state, checkpoints };
}

// 首个 frame >= target 的下标
export function lowerBoundFrame(frames, target) {
  let lo = 0, hi = frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid] < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// 跳到帧 F：状态 = 从头处理完所有 frame < F 的记录（帧 F 之前的两场收尾画面）
export function jumpToFrame(doc, checkpoints, F) {
  const end = lowerBoundFrame(doc.frames, F);
  let k = checkpoints.length - 1;
  while (k > 0 && checkpoints[k].recordIndex > end) k--;
  const cp = checkpoints[k];
  const state = createState();
  restoreCheckpoint(state, cp);
  for (let i = cp.recordIndex; i < end; i++) stepRecord(doc, i, state);
  return state;
}

function gridsEqual(g1, g2) {
  for (let i = 0; i < GRID_SIZE; i++) if (g1[i] !== g2[i]) return false;
  return true;
}

function gridIsEmpty(g) {
  for (let i = 0; i < GRID_SIZE; i++) if (g[i] !== 0) return false;
  return true;
}

function serializeRows(g) {
  const rows = [];
  for (let r = 1; r <= ROWS; r++) {
    let hasChar = false;
    const base = (r - 1) * COLS;
    for (let i = 0; i < COLS; i++) if (g[base + i] !== 0) { hasChar = true; break; }
    if (!hasChar) continue; // 只列含字符的行
    let s = '';
    for (let i = 0; i < COLS; i++) {
      const v = g[base + i];
      s += v === 0 ? ' ' : String.fromCharCode(v); // 空格是字符，空格单元 U+0000
    }
    rows.push({ row: r, cells: s });
  }
  return rows;
}

// ---- 选区导出 ----
// 帧 F 的画面 = 处理完帧 F 两场后的收尾状态；在半开选区 [start,end) 内逐帧成立。
// 逐通道把相同可见网格合并为最大的非空半开区间，端点用源半开帧号，行列保留。
export function buildExport(doc, totalFrames, selectionStart, selectionEnd) {
  const start = Math.max(0, selectionStart | 0);
  const end = Math.min(totalFrames, selectionEnd | 0);
  const state = createState();
  const n = doc.frames.length;

  const openStart = new Int32Array(4).fill(-1);
  const openGrid = new Array(4).fill(null);
  const cues = [];

  const flush = (channel, boundary) => {
    if (openStart[channel] >= 0 && openGrid[channel] !== null) {
      const segStart = Math.max(start, openStart[channel]);
      if (boundary > segStart) {
        cues.push({
          start: segStart,
          end: boundary,
          channel: `CC${channel + 1}`,
          rows: serializeRows(openGrid[channel]),
        });
      }
    }
  };

  // 在帧号 frame 的画面就绪时调用：openStart 记录当前画面首次出现的帧号
  const observe = (frame) => {
    for (let c = 0; c < 4; c++) {
      const g = state.channels[c].display;
      const empty = gridIsEmpty(g);
      if (openStart[c] < 0) {
        if (!empty) { openStart[c] = frame; openGrid[c] = cloneGrid(g); }
      } else if (!gridsEqual(openGrid[c], g)) {
        flush(c, frame);
        openStart[c] = empty ? -1 : frame;
        openGrid[c] = empty ? null : cloneGrid(g);
      }
    }
  };

  // 快进到选区起点：state 成为 S(start)，即处理完 frame<start 的收尾画面
  let i = 0;
  while (i < n && doc.frames[i] < start) { stepRecord(doc, i, state); i++; }
  observe(start);

  // 逐帧处理完整帧 F（两场收尾）。该画面在 S(F+1) 意义下首次可见，
  // 故生效帧号为 F+1；空帧无观察，画面不变即自动合并。
  while (i < n && doc.frames[i] < end) {
    const frame = doc.frames[i];
    const frameEnd = lowerBoundFrame(doc.frames, frame + 1);
    while (i < frameEnd && doc.frames[i] < end) { stepRecord(doc, i, state); i++; }
    observe(frame + 1);
  }
  for (let c = 0; c < 4; c++) flush(c, end);

  cues.sort((x, y) => x.start - y.start || x.channel.localeCompare(y.channel));
  return { start, end, cues };
}

// ---- 记录解码（供界面展示）----
export function decodeRecord(rawA, rawB, status) {
  const parityA = !!PARITY_OK[rawA];
  const parityB = !!PARITY_OK[rawB];
  const base = {
    rawA, rawB, parityA, parityB,
    lowA: rawA & 0x7f, lowB: rawB & 0x7f,
    kind: 'unknown', label: '', channel: null,
  };
  if (status === STATUS.BAD_PARITY || !parityA || !parityB) {
    base.kind = 'badparity';
    base.label = '坏校验丢弃';
    return base;
  }
  const a = base.lowA, b = base.lowB;
  if (isTextLow7(a) && isTextLow7(b)) {
    base.kind = 'text';
    base.label = `文本 "${(a ? String.fromCharCode(a) : '') + (b ? String.fromCharCode(b) : '')}"`;
    return base;
  }
  if (isControlA(a)) {
    base.kind = 'control';
    base.channel = (a >> 3) & 1;
    base.label = CONTROL_NAMES[b] || `未支持控制 1X/${b.toString(16).toUpperCase().padStart(2, '0')}`;
    return base;
  }
  if (isPacRange(a, b)) {
    const rowIndex = 2 * (a & 7) + ((b >> 5) & 1);
    const row = PAC_ROW_TABLE[rowIndex];
    if (row === 0) { base.kind = 'ignored'; base.label = '未支持 PAC'; return base; }
    const col = (b & 0x10) ? 1 + 4 * (b & 7) : 1;
    base.kind = 'pac';
    base.channel = (a >> 3) & 1;
    base.label = `PAC 定位 ${row}行${col}列`;
    return base;
  }
  base.kind = 'ignored';
  base.label = '未支持对（忽略）';
  return base;
}
