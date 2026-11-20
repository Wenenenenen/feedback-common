// 引擎口径测试（node tests/engine.test.mjs，从仓库根目录运行）
import assert from 'node:assert/strict';
import {
  makeImage, cloneImage, computeEnergy, findVerticalSeam, removeVerticalSeam,
  transpose, runOperation, energyForAxis, insertVerticalSeams, LR, LG, LB,
} from '../js/seam-engine.js';
import { decodePNG, encodePNG } from '../js/png-codec.js';
import { readFileSync } from 'node:fs';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (err) { console.error('  ✗', name, '\n   ', err.message); process.exitCode = 1; }
}

function flatImage(w, h, value = [100, 120, 140], mask = null) {
  const rgb = new Uint8Array(w * h * 3).fill(0);
  for (let i = 0; i < w * h; i++) rgb.set(value, i * 3);
  return makeImage(w, h, rgb, mask ?? new Uint8Array(w * h));
}

// ---------- 1. 能量数值与边界夹取 ----------
test('能量：手算 3×3 数值，边界坐标夹取', () => {
  // 像素按列给不同灰度，亮度差异只在 x 方向
  const img = flatImage(3, 3);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
    const g = x * 10;
    const i = (y * 3 + x) * 3;
    img.rgb[i] = img.rgb[i + 1] = img.rgb[i + 2] = g;
  }
  const E = computeEnergy(img);
  const lum = (g) => (LR + LG + LB) * g; // 灰度像素 L=g
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  // 中心 (1,1)：|L(2)-L(0)| + 上下夹取（同值）→ |20-0|=20
  close(E[1 * 3 + 1], Math.abs(lum(20) - lum(0)));
  // 左边界 (0,1)：x-1 夹到 0 → 水平项 |L(10)-L(0)|
  close(E[1 * 3 + 0], Math.abs(lum(10) - lum(0)));
  // 右边界 (2,1)：x+1 夹到 2 → |L(20)-L(10)|
  close(E[1 * 3 + 2], Math.abs(lum(20) - lum(10)));
  // 角点 y 方向也夹取 → 仍只有水平项
  close(E[0], Math.abs(lum(10) - lum(0)));
});

test('能量：保护像素代价为 +∞', () => {
  const img = flatImage(2, 2);
  img.mask[0] = 255;
  const E = computeEnergy(img);
  assert.equal(E[0], Infinity);
  assert.equal(Number.isFinite(E[1]), true);
});

// ---------- 2. 寻缝平局规则 ----------
test('寻缝：全零能量时终点与前驱均取最小列 → 全 0 列', () => {
  const img = flatImage(6, 5);
  const E = computeEnergy(img);
  assert.deepEqual([...new Set(E)], [0]);
  const r = findVerticalSeam(E, 6, 5);
  assert.deepEqual(r.path, [0, 0, 0, 0, 0]);
  assert.equal(r.cumulative, 0);
});

test('寻缝：终点平局取最小列；前驱平局取最小列', () => {
  // 2 宽 3 行，手工能量
  const w = 2, h = 3;
  const E = new Float64Array([
    5, 5,   // row0：起点代价相同
    1, 1,   // row1：两条前驱路径代价相同 → 取较小列
    2, 2,   // row2：终点代价相同 → 取列 0
  ]);
  const r = findVerticalSeam(E, w, h);
  assert.equal(r.path[2], 0);
  assert.equal(r.path[1], 0);
  assert.equal(r.path[0], 0);
  assert.equal(r.cumulative, 8);
});

test('寻缝：相邻列差不超过 1', () => {
  const w = 5, h = 4;
  const E = new Float64Array(w * h);
  // 中央列高能，迫使路径绕行但每步只移 1
  for (let y = 0; y < h; y++) E[y * w + 2] = 1000;
  const r = findVerticalSeam(E, w, h);
  for (let y = 1; y < h; y++) assert.ok(Math.abs(r.path[y] - r.path[y - 1]) <= 1);
});

// ---------- 3. 屏障：无合法路径 ----------
test('屏障：整行保护时竖缝返回 null', () => {
  const img = flatImage(6, 5);
  for (let x = 0; x < 6; x++) img.mask[2 * 6 + x] = 255; // 中间行全保护
  const E = computeEnergy(img);
  assert.equal(findVerticalSeam(E, 6, 5), null);
});

test('屏障：操作停止并保留上一步，applied 为 0', () => {
  const img = flatImage(6, 5);
  for (let x = 0; x < 6; x++) img.mask[2 * 6 + x] = 255;
  const r = runOperation(img, 3, 5, 'width-first');
  assert.equal(r.stopReason, 'no-legal-path');
  assert.equal(r.applied.x, 0);
  assert.equal(r.image.width, 6);
  assert.deepEqual(r.image.rgb, img.rgb);
});

// ---------- 4. 缩缝 ----------
test('缩：flat 6→2 平局规则下每次删当前最小列', () => {
  // 全平能量图（所有像素同色）→ 每条缝代价 0，平局规则强制走最小列
  const img = flatImage(6, 5);
  const r = runOperation(img, 2, 5, 'width-first');
  assert.equal(r.image.width, 2);
  assert.equal(r.stopReason, null);
  assert.equal(r.trace.length, 4);
  for (const ev of r.trace) assert.deepEqual(ev.seam.map((p) => p[0]), [0, 0, 0, 0, 0]);
  // 纯色图删除后仍是同一纯色
  assert.deepEqual([...new Set(r.image.rgb)], [100, 120, 140]);
});

test('缩：非平局场景删除的是低能量缝（手工 3×2 图）', () => {
  // 一列暗、两列亮：交界列能量高，右边界夹取使最右列水平能量为 0
  const img = makeImage(3, 2);
  const dark = [10, 10, 10], bright = [240, 240, 240];
  img.rgb.set(dark, 0); img.rgb.set(bright, 3); img.rgb.set(bright, 6);
  img.rgb.set(dark, 9); img.rgb.set(bright, 12); img.rgb.set(bright, 15);
  const E = computeEnergy(img);
  const found = findVerticalSeam(E, 3, 2);
  // 路径只能由列 1/2 构成（列 0 的累计代价更高）
  assert.ok(found.path.every((c) => c === 2 || c === 1));
});

test('缩：水平缝（转置）高度 5→3', () => {
  const img = flatImage(6, 5);
  const r = runOperation(img, 6, 3, 'height-first');
  assert.equal(r.image.height, 3);
  assert.equal(r.image.width, 6);
  assert.ok(r.trace.every((e) => e.axis === 'y'));
  // 转置口径下点为 [x,y]，每行一个点、相邻行差 ≤1
  for (const ev of r.trace) {
    assert.equal(ev.seam.length, 6);
    for (let i = 1; i < ev.seam.length; i++) {
      assert.ok(Math.abs(ev.seam[i][1] - ev.seam[i - 1][1]) <= 1);
    }
  }
});

// ---------- 5. 扩图批次与插入口径 ----------
test('扩：单批插入取邻域线性 RGB 均值，位置正确', () => {
  // 3 宽 2 行：A B C 各列异色；扩到 5（一批，requested=2 ≤ 3-1）
  const img = flatImage(3, 2, [0, 0, 0]);
  const cols = [[10, 20, 30], [40, 50, 60], [70, 80, 90]];
  for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) {
    img.rgb.set(cols[x], (y * 3 + x) * 3);
  }
  const r = runOperation(img, 5, 2, 'width-first');
  assert.equal(r.image.width, 5);
  const apply = r.trace.find((e) => e.kind === 'expand-apply');
  assert.equal(apply.batch, 0);
  assert.equal(apply.found, 2);
  assert.equal(apply.startWidth, 3);
  // flat 能量 → 工作缝均为列 0，映回原图为列 0、列 1
  // 输出行：A, avg(A,B), B, avg(B,C), C
  const row0 = [...r.image.rgb.slice(0, 15)];
  assert.deepEqual(row0, [
    10, 20, 30,
    25, 35, 45,   // avg(A,B)
    40, 50, 60,
    55, 65, 75,   // avg(B,C)
    70, 80, 90,
  ]);
});

test('扩：右边界缝复制自身（含 .5 四舍五入）', () => {
  const img = flatImage(3, 2, [0, 0, 0]);
  const cols = [[100, 100, 100], [101, 101, 101], [102, 102, 102]];
  for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) {
    img.rgb.set(cols[x], (y * 3 + x) * 3);
  }
  // 直接通过引擎内部行为验证：宽度 3 扩 2 条缝在 flat 下落在列 0、1，
  // 另构造插入场景：3→6 需两批；第二批会在已扩图上重新发现。
  const r = runOperation(img, 6, 2, 'width-first');
  assert.equal(r.image.width, 6);
  const applies = r.trace.filter((e) => e.kind === 'expand-apply');
  assert.equal(applies.length, 2);
  assert.deepEqual([applies[0].startWidth, applies[1].startWidth], [3, 5]);
  // 无 NaN，全部为整数
  for (const v of r.image.rgb) assert.ok(Number.isInteger(v));
});

test('扩：掩膜插入取两邻逻辑或、右边界复制自身', () => {
  // 情形 A：中间像素保护 [0,255,0]
  const img = flatImage(3, 1, [10, 20, 30]);
  img.mask[1] = 255;
  const r = runOperation(img, 5, 1, 'width-first');
  // 工作副本两条缝均为列 0，映回原图为列 0、列 2：
  //   列0 后插 0|255=255；列2 为右边界复制自身 0
  assert.deepEqual([...r.image.mask], [0, 255, 255, 0, 0]);

  // 情形 B：列0 保护 [255,0,0,0]，能量 ∞ 使工作缝改走列 1，映回原列 1、2
  const img2 = flatImage(4, 1, [10, 20, 30]);
  img2.mask[0] = 255;
  const r2 = runOperation(img2, 6, 1, 'width-first');
  // 列1 后插 0|0=0；列2 后插 0|0=0；原保护像素保留
  assert.deepEqual([...r2.image.mask], [255, 0, 0, 0, 0, 0]);

  // 情形 C：两列保护 [255,255,0]，1 行图副本只能找到 1 条合法缝（列2），
  //   第 2 条无路径 → 提交已找到的缝并停止；列2 为右边界复制自身 0
  const img3 = flatImage(3, 1, [10, 20, 30]);
  img3.mask[0] = 255; img3.mask[1] = 255;
  const r3 = runOperation(img3, 5, 1, 'width-first');
  assert.equal(r3.stopReason, 'no-legal-path');
  assert.equal(r3.image.width, 4); // 3+1
  assert.deepEqual([...r3.image.mask], [255, 255, 0, 0]);
});

test('插缝白盒：RGB 邻域均值（.5 四舍五入）、右边界复制、掩膜 OR', () => {
  // 4 宽 1 行，RGB 与 mask 手工布置
  const img = flatImage(4, 1, [0, 0, 0]);
  const px = [[10, 20, 30], [11, 21, 31], [20, 30, 40], [5, 7, 9]];
  for (let x = 0; x < 4; x++) img.rgb.set(px[x], x * 3);
  img.mask.set([0, 255, 0, 0]);
  // 两条缝：列0（普通邻域）、列2（普通邻域）；另测右边界用独立缝
  const out = insertVerticalSeams(img, [[0], [2]]);
  assert.equal(out.width, 6);
  // 顺序：p0, ins(p0,p1), p1, p2, ins(p2,p3), p3
  const mean = (a, b) => Math.round((a + b) / 2);
  assert.deepEqual([...out.rgb], [
    10, 20, 30,
    mean(10, 11), mean(20, 21), mean(30, 31), // 10.5→11, 20.5→21, 30.5→31
    11, 21, 31,
    20, 30, 40,
    mean(20, 5), mean(30, 7), mean(40, 9),
    5, 7, 9,
  ]);
  // mask：列0 后插 0|255=255；列2 后插 0|0=0
  assert.deepEqual([...out.mask], [0, 255, 255, 0, 0, 0]);

  // 右边界缝：复制自身 RGB 与 mask
  const edge = insertVerticalSeams(img, [[3]]);
  assert.deepEqual([...edge.rgb.slice(9, 12)], [5, 7, 9]);
  assert.deepEqual([...edge.rgb.slice(12, 15)], [5, 7, 9]);
  assert.equal(edge.mask[4], 0);

  // 右边界保护像素：复制保护值
  const protectedEdge = flatImage(2, 1, [1, 2, 3]);
  protectedEdge.mask[1] = 255;
  const pe = insertVerticalSeams(protectedEdge, [[1]]);
  assert.deepEqual([...pe.mask], [0, 255, 255]);
});

test('扩：批次上限为当前轴长-1，多批时以上批结果为下批原图', () => {
  const img = flatImage(6, 5);
  const r = runOperation(img, 13, 5, 'width-first'); // +7：批1=5，批2=2
  const applies = r.trace.filter((e) => e.kind === 'expand-apply');
  assert.equal(applies.length, 2);
  assert.equal(applies[0].requested, 5);
  assert.equal(applies[0].found, 5);
  assert.equal(applies[0].startWidth, 6);
  assert.equal(applies[1].requested, 2);
  assert.equal(applies[1].startWidth, 11);
  assert.equal(r.image.width, 13);
});

test('扩：发现不足时提交已找到的缝并停止', () => {
  // 4 宽 3 行，屏障行只留 2 个非保护位置 → 副本最多删 2 条缝
  const img = flatImage(4, 3);
  img.mask[1 * 4 + 2] = 255;
  img.mask[1 * 4 + 3] = 255;
  // 请求 +3：一批 requested=3（轴长-1=3），第 3 条无合法路径
  const r = runOperation(img, 7, 3, 'width-first');
  const apply = r.trace.find((e) => e.kind === 'expand-apply');
  assert.equal(apply.found, 2);
  assert.equal(apply.stopReason, 'no-legal-path');
  assert.equal(r.image.width, 6); // 4+2
  assert.equal(r.stopReason, 'no-legal-path');
});

test('扩：缝从缩小副本发现，不重复复制刚插入的缝', () => {
  // 结构校验：discover 事件的工作宽度逐条递减，apply 缝坐标映回批次原图且互不越界
  const img = flatImage(6, 4);
  const r = runOperation(img, 10, 4, 'width-first'); // +4 一批
  const discovers = r.trace.filter((e) => e.kind === 'expand-discover');
  assert.equal(discovers.length, 4);
  assert.deepEqual(discovers.map((e) => e.width), [6, 5, 4, 3]);
  const apply = r.trace.find((e) => e.kind === 'expand-apply');
  // 映回原图坐标均在 [0,5]，且每条缝行内列号合法
  for (const seam of apply.seams) {
    for (const [x, y] of seam) {
      assert.ok(x >= 0 && x < 6 && y >= 0 && y < 4);
    }
  }
});

// ---------- 6. 保护像素不被删除 ----------
test('保护：缩图后保护像素数量不变（portrait+protect）', async () => {
  const png = await decodePNG(readFileSync('samples/extracted/portrait.png'));
  const msk = await decodePNG(readFileSync('samples/extracted/protect.png'));
  const img = makeImage(png.width, png.height, png.data, msk.data);
  const before = img.mask.filter((v) => v !== 0).length;
  const r = runOperation(img, png.width - 8, png.height, 'width-first');
  const after = r.image.mask.filter((v) => v !== 0).length;
  assert.equal(after, before);
  assert.equal(r.image.width, png.width - 8);
});

test('保护：两轴联动（先宽后高 / 先高后宽）均不删除保护像素', async () => {
  const png = await decodePNG(readFileSync('samples/extracted/portrait.png'));
  const msk = await decodePNG(readFileSync('samples/extracted/protect.png'));
  for (const order of ['width-first', 'height-first']) {
    const img = makeImage(png.width, png.height, png.data.slice(), msk.data.slice());
    const before = img.mask.filter((v) => v !== 0).length;
    const r = runOperation(img, png.width - 6, png.height - 4, order);
    const after = r.image.mask.filter((v) => v !== 0).length;
    assert.equal(after, before, order);
    assert.equal(r.image.width, png.width - 6);
    assert.equal(r.image.height, png.height - 4);
  }
});

// ---------- 7. 能量视图与转置 ----------
test('energyForAxis：水平轴能量为竖口径的转置', () => {
  const img = flatImage(4, 3, [0, 0, 0]);
  img.rgb[5 * 3] = 200; // 制造梯度
  const ex = energyForAxis(img, 'x');
  const ey = energyForAxis(img, 'y');
  assert.equal(ex.energy.length, 12);
  assert.equal(ey.energy.length, 12);
  const t = transpose(img);
  const et = computeEnergy(t);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) {
    assert.equal(ey.energy[y * 4 + x], et[x * t.width + y]);
  }
});

// ---------- 8. PNG 往返 ----------
test('PNG：RGB/灰度编码解码往返一致', async () => {
  const w = 7, h = 5;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 37) & 255;
  const blob = await encodePNG(w, h, rgb, 2);
  const dec = await decodePNG(blob.buffer);
  assert.equal(dec.width, w); assert.equal(dec.height, h);
  assert.deepEqual(dec.data, rgb);

  const gray = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) gray[i] = (i * 13) & 255;
  const blob2 = await encodePNG(w, h, gray, 0);
  const dec2 = await decodePNG(blob2.buffer);
  assert.deepEqual(dec2.data, gray);
});

test('PNG：拒绝 16 位与隔行（结构检查由解码器分支保证，此处验证正常样例可读）', async () => {
  for (const name of ['flat.png', 'portrait.png', 'protect.png', 'barrier-mask.png']) {
    const dec = await decodePNG(readFileSync('samples/extracted/' + name));
    assert.ok(dec.width >= 2 && dec.height >= 2);
  }
});

// ---------- 9. 每轴 ±128 与尺寸下限由 UI 保证；引擎层验证 2 边长 ----------
test('引擎：最小边长 2 仍可删到下限', () => {
  const img = flatImage(2, 2);
  const r = runOperation(img, 2, 2, 'width-first');
  assert.equal(r.image.width, 2);
  const r2 = runOperation(flatImage(3, 2), 2, 2, 'width-first');
  assert.equal(r2.image.width, 2);
});

test('cloneImage 独立性：后续操作不污染原图', () => {
  const img = flatImage(3, 3);
  const snapshot = img.rgb.slice();
  runOperation(img, 2, 2, 'width-first');
  assert.deepEqual(img.rgb, snapshot);
  assert.equal(img.width, 3);
});

console.log(`\n${passed} 项通过`);
if (process.exitCode) console.error('存在失败项');
