// 引擎语义测试：node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  STATUS, createState, stepRecord, simulate, jumpToFrame, buildExport,
  takeCheckpoint, restoreCheckpoint, oddParity, decodeRecord,
} from '../js/engine.js';
import { parseL21P, editRecordBytes, HEADER_SIZE } from '../js/parser.js';

const here = dirname(fileURLToPath(import.meta.url));
const OP = (b7) => oddParity(b7 & 0x7f);

// 构造内存文档：recs = [[frame, field, rawA, rawB], ...]
function makeDoc(recs, totalFrames = 100) {
  const n = recs.length;
  const doc = {
    frames: new Uint32Array(n),
    fields: new Uint8Array(n),
    rawA: new Uint8Array(n),
    rawB: new Uint8Array(n),
    statuses: new Uint8Array(n),
    totalFrames, recordCount: n,
  };
  recs.forEach((r, i) => {
    doc.frames[i] = r[0]; doc.fields[i] = r[1]; doc.rawA[i] = r[2]; doc.rawB[i] = r[3];
  });
  return doc;
}

// 低 7 位对转带校验字节
function P(a7, b7) { return [OP(a7), OP(b7)]; }

function runAll(doc) {
  const state = createState();
  for (let i = 0; i < doc.frames.length; i++) stepRecord(doc, i, state);
  return state;
}

function cell(ch, row, col) {
  return ch.display[(row - 1) * 32 + (col - 1)];
}
function backCell(ch, row, col) {
  return ch.back[(row - 1) * 32 + (col - 1)];
}
function gridSnapshot(state) {
  return state.channels.map((c) => ({
    mode: c.mode, curRow: c.curRow, curCol: c.curCol, baseRow: c.baseRow, rollRows: c.rollRows,
    back: [...c.back], display: [...c.display],
  }));
}

test('样例 L21P 解析与状态演算', () => {
  const buf = readFileSync(join(here, '..', 'samples', 'extracted', '双场.l21p'));
  const { ok, doc, errors } = parseL21P(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  assert.equal(ok, true, JSON.stringify(errors));
  assert.equal(doc.recordCount, 6);
  assert.equal(doc.totalFrames, 18);
  assert.deepEqual([...doc.frames], [0, 1, 3, 3, 4, 9]);
  assert.deepEqual([...doc.fields], [1, 1, 1, 2, 2, 1]);

  runAll(doc);
  assert.deepEqual([...doc.statuses], [
    STATUS.OK, STATUS.OK, STATUS.OK, STATUS.OK, STATUS.OK, STATUS.OK,
  ]);

  // 帧1场1 的 "HI"（C8 49 → 低7位 48 49）写入 CC1 后备（弹出模式，初始游标15行1列）
  const s1 = jumpToFrame(doc, simulate(doc).checkpoints, 2);
  assert.equal(backCell(s1.channels[0], 15, 1), 0x48);
  assert.equal(backCell(s1.channels[0], 15, 2), 0x49);
  assert.equal(cell(s1.channels[0], 15, 1), 0); // 未交换，显示网格仍空
  // 帧3场1 交换：CC1 后备 "HI" 上屏；帧3场2 直写
  const s3 = jumpToFrame(doc, simulate(doc).checkpoints, 4);
  assert.equal(cell(s3.channels[0], 15, 1), 0x48);
  assert.equal(cell(s3.channels[0], 15, 2), 0x49);
  assert.equal(s3.channels[2].mode, 'paint'); // 场2 第一通道 CC3 直写
  assert.equal(s3.channels[0].mode, 'pop');
  // 帧4场2 的 "TV" 直写 CC3 显示（跳帧5：半开，含帧4全部记录）
  const s4b = jumpToFrame(doc, simulate(doc).checkpoints, 5);
  assert.equal(cell(s4b.channels[2], 15, 1), 0x54);
  assert.equal(cell(s4b.channels[2], 15, 2), 0x56);
  // 帧9 清显示后 CC1 显示清空，模式不变
  const s9 = jumpToFrame(doc, simulate(doc).checkpoints, 10);
  assert.ok(s9.channels[0].display.every((v) => v === 0));
});

test('坏校验丢整对：游标与网格均不变', () => {
  const doc = makeDoc([
    [1, 1, ...P(0x48, 0x49)],       // 文本 HI 入后备
    [2, 1, 0x50, 0xd6],             // 0x50 低7位偶校验（popcount=2），整对坏
  ]);
  const s = runAll(doc);
  assert.equal(doc.statuses[1], STATUS.BAD_PARITY);
  assert.equal(backCell(s.channels[0], 15, 1), 0x48);
  assert.equal(backCell(s.channels[0], 15, 2), 0x49);
  assert.equal(backCell(s.channels[0], 15, 3), 0); // 坏对未写入
  assert.equal(s.channels[0].curCol, 3);
});

test('弹出双缓冲：写后备，交换后上屏并复位', () => {
  const doc = makeDoc([
    [1, 1, ...P(0x41, 0x42)],       // AB 入后备
    [2, 1, ...P(0x14, 0x2f)],       // 交换
  ]);
  const s = runAll(doc);
  const ch = s.channels[0];
  assert.equal(cell(ch, 15, 1), 0x41);
  assert.equal(cell(ch, 15, 2), 0x42);
  assert.ok(ch.back.every((v) => v === 0)); // 交换后旧显示（空）到后备
  assert.equal(ch.mode, 'pop');
  assert.equal(ch.curRow, 15);
  assert.equal(ch.curCol, 1);
});

test('直写直接进显示网格', () => {
  const doc = makeDoc([
    [1, 1, ...P(0x14, 0x29)],       // 直写
    [2, 1, ...P(0x43, 0x00)],       // C + NOP
  ]);
  const s = runAll(doc);
  assert.equal(cell(s.channels[0], 15, 1), 0x43);
  assert.ok(s.channels[0].back.every((v) => v === 0));
});

test('退格与清到行末', () => {
  const doc = makeDoc([
    [1, 1, ...P(0x41, 0x42)],       // 后备: AB，游标 col3
    [2, 1, ...P(0x14, 0x21)],       // 退格：删 B，col2
    [3, 1, ...P(0x14, 0x24)],       // 清到行末（含游标格 col2）
  ]);
  const s = runAll(doc);
  const g = s.channels[0].back;
  const base = 14 * 32; // 初始游标 15 行
  assert.equal(g[base], 0x41);
  assert.equal(g[base + 1], 0);
  assert.equal(s.channels[0].curCol, 2);
});

test('首列退格无操作', () => {
  const doc = makeDoc([[1, 1, ...P(0x14, 0x21)]]);
  const s = runAll(doc);
  assert.equal(s.channels[0].curCol, 1);
});

test('列32饱和后覆盖', () => {
  const recs = [];
  let f = 1;
  for (let k = 0; k < 16; k++) recs.push([f++, 1, ...P(0x41, 0x42)]); // 32 字符
  recs.push([f++, 1, ...P(0x58, 0x59)]); // 第 33、34 次写：col32 覆盖为 Y
  const doc = makeDoc(recs);
  const s = runAll(doc);
  const g = s.channels[0].back;
  const base = 14 * 32; // 第 15 行
  assert.equal(g[base + 30], 0x41);
  assert.equal(g[base + 31], 0x59);
  assert.equal(s.channels[0].curCol, 32);
});

test('清显示/清后备', () => {
  const doc = makeDoc([
    [1, 1, ...P(0x41, 0x42)],
    [2, 1, ...P(0x14, 0x2e)],       // 清后备
    [3, 1, ...P(0x43, 0x00)],
    [4, 1, ...P(0x14, 0x2f)],       // 交换：C 上屏
    [5, 1, ...P(0x14, 0x2c)],       // 清显示
  ]);
  const s = runAll(doc);
  assert.ok(s.channels[0].display.every((v) => v === 0));
  assert.ok(s.channels[0].back.every((v) => v === 0));
});

test('四通道独立、A位3选道且当前通道粘滞', () => {
  const doc = makeDoc([
    [1, 1, ...P(0x1c, 0x20)],       // 场1 第二通道 CC2，切弹出
    [2, 1, ...P(0x58, 0x00)],       // X 入 CC2 后备
    [1, 2, ...P(0x14, 0x20)],       // 场2 第一通道 CC3
    [2, 2, ...P(0x59, 0x00)],       // Y 入 CC3 后备
  ]);
  const s = runAll(doc);
  assert.equal(backCell(s.channels[1], 15, 1), 0x58);
  assert.equal(backCell(s.channels[2], 15, 1), 0x59);
  assert.equal(s.fields[0].current, 1);
  assert.equal(s.fields[1].current, 0);
  assert.ok(s.channels[0].back.every((v) => v === 0));
});

test('重复控制：连续帧同字节对抑制，抑制后候选清除', () => {
  const doc = makeDoc([
    [1, 1, ...P(0x14, 0x20)],
    [2, 1, ...P(0x14, 0x20)], // 抑制
    [3, 1, ...P(0x14, 0x20)], // 上条抑制清了候选，本条执行
  ]);
  runAll(doc);
  assert.deepEqual([...doc.statuses], [STATUS.OK, STATUS.SUPPRESSED, STATUS.OK]);
});

test('缺帧打断重复检测', () => {
  const doc = makeDoc([
    [1, 1, ...P(0x14, 0x20)],
    [3, 1, ...P(0x14, 0x20)], // 帧2缺失，不抑制
  ]);
  runAll(doc);
  assert.deepEqual([...doc.statuses], [STATUS.OK, STATUS.OK]);
});

test('文本与忽略打断重复检测；两场互不影响', () => {
  const doc = makeDoc([
    [1, 1, ...P(0x14, 0x20)],
    [1, 2, ...P(0x14, 0x20)], // 另一场同对，不参与判定，执行
    [2, 1, ...P(0x41, 0x00)], // 文本打断
    [3, 1, ...P(0x14, 0x20)], // 执行
    [4, 1, ...P(0x14, 0x99)], // 未支持控制，忽略
    [5, 1, ...P(0x14, 0x99)], // 候选已被清，执行尝试→仍忽略
  ]);
  runAll(doc);
  assert.deepEqual([...doc.statuses], [
    STATUS.OK, STATUS.OK, STATUS.OK, STATUS.OK, STATUS.IGNORED, STATUS.IGNORED,
  ]);
});

test('PAC 行列定位与未支持 index 0', () => {
  const doc = makeDoc([
    [1, 1, ...P(0x11, 0x40)], // index 2*1+0=2 → 行1，位4=0 → 列1
    [2, 1, ...P(0x13, 0x52)], // index 2*3+0=6 → 行12；位4=1, B低3位=2 → 列9
    [3, 1, ...P(0x10, 0x60)], // index 0+1=1 → 表值0 → 未支持
  ]);
  const s = runAll(doc);
  assert.equal(s.channels[0].curRow, 12);
  assert.equal(s.channels[0].curCol, 9);
  assert.equal(doc.statuses[2], STATUS.IGNORED);
});

test('滚动：进入清两网格、CR 上卷、基行清空', () => {
  const doc = makeDoc([
    [1, 1, ...P(0x41, 0x42)],        // 后备 AB
    [2, 1, ...P(0x14, 0x25)],        // RU2：清两网格
    [3, 1, ...P(0x43, 0x00)],        // 显示 row15 col1 = C
    [4, 1, ...P(0x14, 0x2d)],        // CR：C 到 row14，row15 清空
  ]);
  const s = runAll(doc);
  const ch = s.channels[0];
  assert.equal(ch.mode, 'roll');
  assert.ok(ch.back.every((v) => v === 0));
  assert.equal(cell(ch, 14, 1), 0x43);
  assert.equal(cell(ch, 15, 1), 0);
  assert.equal(ch.curRow, 15);
  assert.equal(ch.curCol, 1);
});

test('滚动 PAC 改基行：相对搬迁并裁剪越界行', () => {
  const doc = makeDoc([
    [1, 1, ...P(0x14, 0x25)],        // RU2，窗口 14-15
    [2, 1, ...P(0x41, 0x00)],        // row15: A
    [3, 1, ...P(0x11, 0x40)],        // PAC 行1列1 → 基行1，窗口 1-2；旧15→1
    [4, 1, ...P(0x42, 0x00)],        // row1: B（覆盖 A 的位置）
  ]);
  const s = runAll(doc);
  const ch = s.channels[0];
  assert.equal(ch.baseRow, 1);
  assert.equal(cell(ch, 1, 1), 0x42); // A 被 B 覆盖
  assert.equal(cell(ch, 15, 1), 0);   // 旧位置已裁走
  // 再来：基行移到 3，窗口 2-3，row1 内容越界裁掉
  const doc2 = makeDoc([
    [1, 1, ...P(0x14, 0x25)],
    [2, 1, ...P(0x11, 0x40)],        // 基行1
    [3, 1, ...P(0x41, 0x00)],        // row1 A
    [4, 1, ...P(0x12, 0x40)],        // PAC 行3（index 2*2=4 → 表3）基行3，窗口2-3；旧1→-1 裁掉
  ]);
  const s2 = runAll(doc2);
  assert.equal(s2.channels[0].baseRow, 3);
  // 旧 row1 按相对偏移 +2 搬到 row3（窗口 2-3 内），不裁剪
  assert.equal(cell(s2.channels[0], 3, 1), 0x41);
  assert.equal(cell(s2.channels[0], 1, 1), 0);
  assert.equal(s2.channels[0].curRow, 3);
  assert.equal(s2.channels[0].curCol, 1);

  // 搬迁保留：RU4 下基行 15→11→12，内容随相对偏移移动且不丢
  const doc3 = makeDoc([
    [1, 1, ...P(0x14, 0x27)],        // RU4，基行15，窗口12-15
    [2, 1, ...P(0x10, 0x40)],        // PAC index0 → 表11，基行11，窗口8-11；旧15→11
    [3, 1, ...P(0x41, 0x00)],        // row11 写 A
    [4, 1, ...P(0x13, 0x40)],        // PAC index6 → 表12，基行12；旧11→12
  ]);
  const s3 = runAll(doc3);
  assert.equal(s3.channels[0].baseRow, 12);
  assert.equal(cell(s3.channels[0], 12, 1), 0x41);
  assert.equal(cell(s3.channels[0], 11, 1), 0);

  // 真正越界：内容在窗口顶行，基行下移后该行新行号 < 1 被裁
  // 注：行14/15 的 PAC 编码 A=0x14/0x1C 与控制码域重叠，按控制优先不可达
  const doc4 = makeDoc([
    [1, 1, ...P(0x14, 0x27)],        // RU4，基行15，窗口12-15
    [2, 1, ...P(0x12, 0x40)],        // PAC 行3，基行3，窗口1-4
    [3, 1, ...P(0x41, 0x00)],        // row3 写 A
    [4, 1, ...P(0x11, 0x40)],        // PAC 行1，基行1，窗口1-2；旧3→1 保留
    [5, 1, ...P(0x13, 0x60)],        // PAC 行13，基行13；旧1→11 保留
    [6, 1, ...P(0x13, 0x40)],        // PAC 行12，基行12；旧11→10 保留
    [7, 1, ...P(0x10, 0x40)],        // PAC 行11，基行11；旧10→9 保留
  ]);
  const s4 = runAll(doc4);
  assert.equal(cell(s4.channels[0], 11, 1), 0x41); // 一路搬迁不丢

  // 真正越界裁剪：CR 上卷产生两行内容，基行从 15 跳到 1
  // row14 的 A 随 delta=-14 搬到 row0（<1）裁掉；row15 的 B 搬到 row1 保留
  const doc5 = makeDoc([
    [1, 1, ...P(0x14, 0x27)],        // RU4，基行15，窗口12-15
    [2, 1, ...P(0x41, 0x00)],        // row15 A
    [3, 1, ...P(0x14, 0x2d)],        // CR：A 上卷到 row14，row15 清空
    [4, 1, ...P(0x42, 0x00)],        // row15 B
    [5, 1, ...P(0x11, 0x40)],        // PAC 行1，基行1，窗口1-4
  ]);
  const s5 = runAll(doc5);
  assert.equal(s5.channels[0].baseRow, 1);
  assert.equal(cell(s5.channels[0], 1, 1), 0x42);
  assert.ok(s5.channels[0].display.every((v, k) => v === 0 || ((k / 32 | 0) + 1) === 1));
});

test('滚动高度调整保留窗口内行', () => {
  const doc = makeDoc([
    [1, 1, ...P(0x14, 0x25)],        // RU2 窗口14-15
    [2, 1, ...P(0x41, 0x00)],        // row15 A
    [3, 1, ...P(0x14, 0x27)],        // RU4 窗口12-15，row15 保留
  ]);
  const s = runAll(doc);
  assert.equal(cell(s.channels[0], 15, 1), 0x41);
  assert.equal(s.channels[0].rollRows, 4);
});

test('CR 仅滚动模式生效；模式切换只切模式', () => {
  const doc = makeDoc([
    [1, 1, ...P(0x41, 0x00)],
    [2, 1, ...P(0x14, 0x2d)],        // 弹出模式下 CR 无操作
    [3, 1, ...P(0x14, 0x29)],        // 直写
  ]);
  const s = runAll(doc);
  assert.equal(backCell(s.channels[0], 15, 1), 0x41);
  assert.equal(s.channels[0].mode, 'paint');
  assert.equal(s.channels[0].curCol, 2); // 模式切换不动游标
});

test('跳帧与从头读到该帧的两场收尾画面一致', () => {
  const recs = [];
  let f = 1;
  const seq = [
    () => P(0x14, 0x25), () => P(0x41, 0x42), () => P(0x14, 0x2d),
    () => P(0x11, 0x40), () => P(0x43, 0x00), () => P(0x14, 0x2f),
    () => P(0x1c, 0x29), () => P(0x58, 0x59), () => P(0x14, 0x2c),
  ];
  for (let k = 0; k < 60; k++) {
    if (k % 3 !== 0) recs.push([f, (k % 2) + 1, ...seq[k % seq.length]()]); // 制造缺帧
    f += 1 + (k % 4 === 0 ? 1 : 0);
  }
  const totalFrames = f + 5;
  const doc = makeDoc(recs, totalFrames);
  const { checkpoints } = simulate(doc, 7); // 小间隔强制多检查点
  for (let F = 0; F <= totalFrames; F++) {
    const jumped = jumpToFrame(doc, checkpoints, F);
    const fresh = createState();
    let i = 0;
    while (i < doc.frames.length && doc.frames[i] < F) { stepRecord(doc, i, fresh); i++; }
    assert.deepEqual(gridSnapshot(jumped), gridSnapshot(fresh), `帧 ${F} 状态不一致`);
    assert.deepEqual(jumped.fields, fresh.fields, `帧 ${F} 场状态不一致`);
  }
});

test('检查点恢复等价', () => {
  const doc = makeDoc([
    [1, 1, ...P(0x41, 0x42)],
    [2, 1, ...P(0x14, 0x2f)],
    [3, 1, ...P(0x14, 0x25)],
    [4, 1, ...P(0x43, 0x00)],
  ]);
  const s1 = runAll(doc);
  const cp = takeCheckpoint(s1, 4);
  const s2 = createState();
  restoreCheckpoint(s2, cp);
  assert.deepEqual(gridSnapshot(s2), gridSnapshot(s1));
});

test('选区导出：半开源帧端点、按通道合并、NUL 与空格保留', () => {
  const recs = [
    [1, 1, ...P(0x41, 0x20)],        // 后备 row15: A, 空格
    [2, 1, ...P(0x14, 0x2f)],        // 交换：帧2起显示
    [3, 1, ...P(0x14, 0x20)],        // 重复控制不影响网格，区间应连续
    [6, 1, ...P(0x14, 0x2c)],        // 帧6清空
    [7, 2, ...P(0x5a, 0x00)],        // CC3 后备（不上屏，不产生 cue）
  ];
  const doc = makeDoc(recs, 12);
  const out = buildExport(doc, 12, 0, 12);
  assert.equal(out.start, 0);
  assert.equal(out.end, 12);
  const cc1 = out.cues.filter((c) => c.channel === 'CC1');
  assert.equal(cc1.length, 1);
  // 交换在帧2收尾，画面 S(3) 起可见；帧6清空，S(7) 起为空 → [3,7)
  assert.deepEqual([cc1[0].start, cc1[0].end], [3, 7]);
  const row = cc1[0].rows[0];
  assert.equal(row.row, 15);
  assert.equal(row.cells[0], 'A');
  assert.equal(row.cells[1], ' ');   // 空格是字符
  assert.equal(row.cells[2], ' ');  // 空格单元 U+0000
  assert.equal(row.cells.length, 32);
  // 排序：start 升序、通道升序
  const keys = out.cues.map((c) => `${c.start}:${c.channel}`);
  assert.deepEqual(keys, [...keys].sort());
  assert.ok(!out.cues.some((c) => c.channel === 'CC3')); // 后备内容不导出
});

test('导出选区边界与相同网格跨多帧合并', () => {
  const recs = [
    [1, 1, ...P(0x41, 0x00)],
    [2, 1, ...P(0x14, 0x2f)],        // 帧2显示 A
    [8, 1, ...P(0x14, 0x2c)],        // 帧8清空
  ];
  const doc = makeDoc(recs, 20);
  const out = buildExport(doc, 20, 4, 16); // 选区从4开始：cue 起点夹到4
  assert.equal(out.cues.length, 1);
  // 帧8清空，画面 S(9) 起为空 → end=9
  assert.deepEqual([out.cues[0].start, out.cues[0].end], [4, 9]);
});

test('导出保留空格(0x20)与空单元(U+0000)的区别', () => {
  // 同帧两场各写一对，帧2两场收尾后画面含 A、空格、B
  const recs = [
    [1, 1, ...P(0x14, 0x29)],        // 场1 直写
    [2, 1, ...P(0x41, 0x20)],        // 场1：A + 空格
    [2, 2, ...P(0x42, 0x00)],        // 场2 第一通道 CC3 也直写（独立通道，不影响 CC1）
  ];
  const doc = makeDoc(recs, 10);
  // CC1 的画面在帧2收尾后为 A、空格（B 在 CC3）；直接验证 CC1 行
  const out = buildExport(doc, 10, 0, 10);
  const cc1 = out.cues.find((c) => c.channel === 'CC1');
  const cells = cc1.rows[0].cells;
  assert.equal(cells.charCodeAt(0), 0x41); // 列1 A
  assert.equal(cells.charCodeAt(1), 0x20); // 列2 空格是真实字符
  assert.equal(cells.charCodeAt(2), 0x00); // 列3 未写单元 U+0000
  assert.equal(cells.charCodeAt(3), 0x00);

  // 同一通道内 A、空格、B 连续三格（用两条同帧记录做不到，改跨帧验证 B 接续）
  const recs2 = [
    [1, 1, ...P(0x14, 0x29)],
    [2, 1, ...P(0x41, 0x20)],        // A 空格
    [3, 1, ...P(0x42, 0x00)],        // B 接续到列3
  ];
  const doc2 = makeDoc(recs2, 10);
  const out2 = buildExport(doc2, 10, 0, 10);
  const last = out2.cues[out2.cues.length - 1];
  const cs = last.rows[0].cells;
  assert.equal(cs.charCodeAt(0), 0x41);
  assert.equal(cs.charCodeAt(1), 0x20);
  assert.equal(cs.charCodeAt(2), 0x42);
  assert.equal(cs.charCodeAt(3), 0x00);
});

test('结构错误：偏移标注', () => {
  const good = new Uint8Array(HEADER_SIZE + 8);
  const dv = new DataView(good.buffer);
  dv.setUint32(0, 0x5031324c, false); // 不对，直接写字节
  good.set([0x4c, 0x32, 0x31, 0x50], 0);
  dv.setUint32(4, 1, true);
  dv.setUint32(8, 10, true);
  dv.setUint32(12, 5, true); // 帧5
  good[16] = 1; good[17] = OP(0x41); good[18] = OP(0);
  let r = parseL21P(good.buffer);
  assert.equal(r.ok, true);

  const bad = good.slice();
  bad[16] = 3; // 非法场号
  r = parseL21P(bad.buffer);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.offset === 16));

  const badMagic = good.slice();
  badMagic[0] = 0x58;
  r = parseL21P(badMagic.buffer);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.offset === 0));
});

test('改字节对后重新演算；编辑保留结构', () => {
  const recs = [[1, 1, ...P(0x41, 0x42)]];
  const bytes = new Uint8Array(HEADER_SIZE + 8);
  bytes.set([0x4c, 0x32, 0x31, 0x50], 0);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(4, 1, true); dv.setUint32(8, 10, true);
  dv.setUint32(12, recs[0][0], true);
  bytes[16] = recs[0][1]; bytes[17] = recs[0][2]; bytes[18] = recs[0][3];

  const next = editRecordBytes(bytes.buffer, 0, OP(0x58), OP(0x59));
  const r = parseL21P(next);
  assert.equal(r.ok, true);
  const s = runAll(r.doc);
  assert.equal(backCell(s.channels[0], 15, 1), 0x58);
  assert.equal(backCell(s.channels[0], 15, 2), 0x59);
});

test('decodeRecord 分类', () => {
  assert.equal(decodeRecord(OP(0x14), OP(0x2f), STATUS.OK).kind, 'control');
  assert.equal(decodeRecord(OP(0x11), OP(0x40), STATUS.OK).kind, 'pac');
  assert.equal(decodeRecord(OP(0x48), OP(0x49), STATUS.OK).kind, 'text');
  assert.equal(decodeRecord(0x54, 0xd6, STATUS.BAD_PARITY).kind, 'badparity');
  assert.equal(decodeRecord(OP(0x14), OP(0x99), STATUS.IGNORED).kind, 'control');
});
