// 生成 100 万条 L21P 记录的基准文件（混合文本/控制/PAC/坏校验/缺帧/双场）
import { writeFileSync } from 'node:fs';
import { oddParity } from '../js/engine.js';
import { HEADER_SIZE, RECORD_SIZE } from '../js/parser.js';

const OP = (b7) => oddParity(b7 & 0x7f);
const N = 1_000_000;
// 同帧两场共用帧号：帧每 2 条记录推进，步长 1 或 2；2N 保证绝不触顶
const totalFrames = 2 * N;
const bytes = new Uint8Array(HEADER_SIZE + N * RECORD_SIZE);
const dv = new DataView(bytes.buffer);
bytes.set([0x4c, 0x32, 0x31, 0x50], 0);
dv.setUint32(4, N, true);
dv.setUint32(8, totalFrames, true);

const textPairs = [[0x48, 0x49], [0x4f, 0x20], [0x54, 0x56], [0x41, 0x42], [0x58, 0x00]];
const controls = [[0x14, 0x20], [0x14, 0x29], [0x14, 0x2f], [0x14, 0x25], [0x14, 0x26], [0x14, 0x27], [0x14, 0x2d], [0x14, 0x2c], [0x14, 0x2e], [0x14, 0x21], [0x14, 0x24]];
const pacs = [[0x11, 0x40], [0x13, 0x52], [0x12, 0x40], [0x10, 0x40], [0x13, 0x60]];

let frame = 0;
let rec = 0;
let rng = 0x12345678;
const rand = () => { rng = (rng * 1664525 + 1013904223) >>> 0; return rng / 4294967296; };

while (rec < N) {
  frame += 1 + (rand() < 0.08 ? 2 : 1); // 约 8% 缺帧，打断重复检测
  // 同一帧先场1再场2（各最多一条），保持严格递增
  for (let field = 1; field <= 2 && rec < N; field++) {
    const pick = rand();
    let a7, b7;
    if (pick < 0.55) [a7, b7] = textPairs[(rand() * textPairs.length) | 0];
    else if (pick < 0.85) [a7, b7] = controls[(rand() * controls.length) | 0];
    else [a7, b7] = pacs[(rand() * pacs.length) | 0];

    const off = HEADER_SIZE + rec * RECORD_SIZE;
    dv.setUint32(off, frame, true);
    bytes[off + 4] = field;
    // 约 1% 故意制造坏校验（清掉最高位且保证偶校验）
    if (rand() < 0.01) {
      bytes[off + 5] = a7 & 0x7f;
      bytes[off + 6] = b7 & 0x7f;
    } else {
      bytes[off + 5] = OP(a7);
      bytes[off + 6] = OP(b7);
    }
    rec++;
  }
}

writeFileSync(new URL('../bench-1m.l21p', import.meta.url), bytes);
console.log(`wrote ${N} records, ${bytes.length} bytes`);
