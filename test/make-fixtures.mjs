// 生成正确性测试夹具（.cxr），随后由 reference_decoder.py 产生参考输出，
// 再由 node test/run-correctness.mjs 与 JS 解码器逐字节比对。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CxrWriter } from '../tools/cxr-writer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'fixtures');
mkdirSync(OUT, { recursive: true });

const solid = (w, h, [r, g, b, a]) => {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set([r, g, b, a], i * 4);
  return px;
};
const pattern = (w, h) => {
  // 每个像素带坐标，便于发现搬错位置
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      px[i] = (x * 7) & 0xff;
      px[i + 1] = (y * 11) & 0xff;
      px[i + 2] = (x + y * 13) & 0xff;
      px[i + 3] = 255;
    }
  }
  return px;
};

function save(name, buf) {
  writeFileSync(join(OUT, name), buf);
  console.log('written', name, buf.length);
}

// ---- 1. 基本关键帧 + 差量 + 裁剪移动 + 部分出界脏块 ----------------------
{
  const W = 12;
  const H = 10;
  const w = new CxrWriter(W, H);
  w.addKeyframe(0, pattern(W, H));
  // 移动：源在画布内，目的部分出界（右下）
  w.addDelta(1, 0, [[2, 2, 4, 4, 9, 7]], [
    { x: -2, y: -1, w: 4, h: 3, pixels: solid(4, 3, [10, 20, 30, 255]) },
  ]);
  // 移动：目的完全出界（不写），脏块完全出界（不写），零面积脏块
  w.addDelta(2, 1, [[0, 0, 2, 2, 50, 50]], [
    { x: 100, y: 100, w: 2, h: 2, pixels: solid(2, 2, [1, 2, 3, 4]) },
    { x: 3, y: 3, w: 0, h: 0, pixels: new Uint8Array(0) },
  ]);
  // 源部分出界：只有源/目同时在画布内的交集被搬
  w.addDelta(3, 2, [[-2, -2, 6, 6, 4, 4]], []);
  save('basic-clips.cxr', w.build());
}

// ---- 2. 移动顺序敏感：重叠移动必须各自从同一上一成功帧取像素 -------------
{
  const W = 8;
  const H = 8;
  const w = new CxrWriter(W, H);
  w.addKeyframe(0, pattern(W, H));
  // 三块链式重叠：若实现错误地在同缓冲上搬，结果会与参考不同
  w.addDelta(1, 0, [
    [0, 0, 4, 4, 2, 2],
    [2, 2, 4, 4, 4, 4],
    [4, 4, 4, 4, 0, 0],
  ], [
    { x: 6, y: 6, w: 2, h: 2, pixels: solid(2, 2, [9, 9, 9, 255]) },
  ]);
  // 再来一帧，验证上一帧确实成功
  w.addDelta(2, 1, [[1, 1, 3, 3, 4, 1]], []);
  save('move-order.cxr', w.build());
}

// ---- 3. CRC 错断链，差量停用，合法关键帧恢复 ------------------------------
{
  const W = 6;
  const H = 6;
  const w = new CxrWriter(W, H);
  w.addKeyframe(10, pattern(W, H));
  w.addDelta(11, 10, [], [
    { x: 1, y: 1, w: 2, h: 2, pixels: solid(2, 2, [5, 5, 5, 255]) },
  ]);
  // CRC 错误的差量帧
  w.addDelta(12, 11, [], [
    { x: 0, y: 0, w: 1, h: 1, pixels: solid(1, 1, [7, 7, 7, 255]) },
  ], { badCrc: true });
  // 断链期间的差量帧：base 即使写 12 也必须拒绝
  w.addDelta(13, 12, [], [
    { x: 2, y: 2, w: 1, h: 1, pixels: solid(1, 1, [8, 8, 8, 255]) },
  ]);
  // 合法关键帧恢复
  w.addKeyframe(20, solid(W, H, [40, 50, 60, 255]));
  w.addDelta(21, 20, [], [
    { x: 0, y: 0, w: 3, h: 3, pixels: solid(3, 3, [1, 1, 1, 255]) },
  ]);
  save('crc-chain.cxr', w.build());
}

// ---- 4. base 不符 / seq 不递增 / 关键帧约束破坏 ---------------------------
{
  const W = 5;
  const H = 5;
  const w = new CxrWriter(W, H);
  w.addKeyframe(0, pattern(W, H));
  // base 指向不存在的 seq=99
  w.addDelta(1, 99, [], [
    { x: 0, y: 0, w: 1, h: 1, pixels: solid(1, 1, [1, 1, 1, 1]) },
  ]);
  // 新关键帧恢复
  w.addKeyframe(5, solid(W, H, [2, 2, 2, 255]));
  // seq 回退
  w.addDelta(4, 5, [], [
    { x: 0, y: 0, w: 1, h: 1, pixels: solid(1, 1, [3, 3, 3, 3]) },
  ]);
  save('base-seq.cxr', w.build());

  // 非法关键帧：带移动记录
  const w2 = new CxrWriter(W, H);
  {
    const parts = [
      u32buf(0), u32buf(0xffffffff), u8buf(1), u16buf(1), u16buf(0),
      i16buf(0), i16buf(0), u16buf(1), u16buf(1), i16buf(0), i16buf(0),
    ];
    w2.addRawFrame(Buffer.concat(parts));
    w2.addKeyframe(1, solid(W, H, [4, 4, 4, 255]));
  }
  save('bad-keyframe.cxr', w2.build());
}

// ---- 5. 帧体非法：脏块像素越界、帧体未用完 --------------------------------
{
  const W = 4;
  const H = 4;
  const w = new CxrWriter(W, H);
  w.addKeyframe(0, pattern(W, H));
  {
    // 声明 2×2 脏块但只给 4 字节（应 16）
    const body = Buffer.concat([
      u32buf(1), u32buf(0), u8buf(0), u16buf(0), u16buf(1),
      i16buf(0), i16buf(0), u16buf(2), u16buf(2),
      Buffer.from([1, 2, 3, 4]),
    ]);
    w.addRawFrame(body);
  }
  {
    // 结构完整但帧体多 1 字节
    const body = Buffer.concat([
      u32buf(2), u32buf(0), u8buf(0), u16buf(0), u16buf(0),
      Buffer.from([0xee]),
    ]);
    w.addRawFrame(body);
  }
  // 恢复关键帧
  w.addKeyframe(3, solid(W, H, [6, 6, 6, 255]));
  save('malformed-body.cxr', w.build());
}

// ---- 6. 截断尾帧 -----------------------------------------------------------
{
  const W = 4;
  const H = 4;
  const w = new CxrWriter(W, H);
  w.addKeyframe(0, pattern(W, H));
  w.addDelta(1, 0, [], [
    { x: 0, y: 0, w: 2, h: 2, pixels: solid(2, 2, [1, 2, 3, 4]) },
  ]);
  // 声明一个 L=100 的帧，只给 10 字节
  w.appendTruncatedFrame(100, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
  save('truncated-tail.cxr', w.build());

  // 长度字段本身被截断
  const w2 = new CxrWriter(W, H);
  w2.addKeyframe(0, pattern(W, H));
  w2.chunks.push(Buffer.from([0x10, 0x00]));
  save('truncated-lenfield.cxr', w2.build());

  // L < 4
  const w3 = new CxrWriter(W, H);
  w3.addKeyframe(0, pattern(W, H));
  w3.chunks.push(u32buf(2));
  save('tiny-l.cxr', w3.build());
}

// ---- 7. 多关键帧、长链随机访问（快照/锚点路径都要覆盖） --------------------
{
  const W = 16;
  const H = 16;
  const w = new CxrWriter(W, H);
  let seq = 0;
  w.addKeyframe(seq, pattern(W, H));
  for (let k = 1; k <= 3; k++) {
    for (let t = 1; t <= 300; t++) {
      seq++;
      w.addDelta(seq, seq - 1, [
        [(t + k) % 8, (t * 2) % 8, 3, 3, (t * 3 + 1) % 12, (t + k) % 12],
      ], [
        {
          x: t % W,
          y: (t * 5) % H,
          w: 2,
          h: 2,
          pixels: solid(2, 2, [t & 0xff, k * 17, (t * k) & 0xff, 255]),
        },
      ]);
    }
    seq++;
    // 周期关键帧（满画布新图案）
    w.addKeyframe(seq, pattern(W, H).map((v, i) => (i % 4 === 3 ? v : (v + k) & 0xff)));
  }
  save('long-chain.cxr', w.build());
}

// ---- 小端打包辅助（与 writer 内部一致，这里给原始帧用） --------------------
function u8buf(v) { const b = Buffer.alloc(1); b.writeUInt8(v); return b; }
function u16buf(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v >>> 0); return b; }
function i16buf(v) { const b = Buffer.alloc(2); b.writeInt16LE(v); return b; }
function u32buf(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; }
